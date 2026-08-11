import * as THREE from "three";

// Hand-rolled WebXR-WebGPU presentation for visionOS.
//
// three r186dev's native WebGPU XR path assumes the spec draft: a projection
// layer that reports its texture size, one shared texture array across
// views, and per-view viewports that fit inside it. visionOS Safari 26
// violates all three at once — textureWidth/Height are 0, each view hands
// back its own colorTexture wrapper whose depthOrArrayLayers getter says 1
// even though the view descriptors index layer 1, and viewports come back
// at the logical foveated resolution (larger than the physical texture).
// Every one of those breaks a different assumption inside three's
// external-texture attachment code, and the failures surface only as
// "encoder state is 'Locked'" at finish().
//
// So: keep three for everything that works — session lifecycle, reference
// space, per-eye pose/projection, scene rendering — and bypass its XR
// *output* entirely. Each eye renders into an ordinary HDR render target,
// and a raw WebGPU fullscreen pass (same pattern as the snow sim) blits it
// into Apple's texture through Apple's own getViewDescriptor(), applying
// three's AgX tone map + sRGB encode in the shader (render-target passes
// skip the renderer's output transform).
//
// The provided depthStencilTexture is left unwritten; the compositor's
// reprojection just has no depth to chew on, which is cosmetic.

// Per-eye render targets are sized to a shaded-pixel budget rather than a
// fixed fraction: visionOS killed the web content process outright at full
// res x2 eyes, and the sub-image size can change (foveation on/off).
// ~1.2 MP/eye keeps the total below what the desktop canvas renders fine.
const EYE_PIXEL_BUDGET = 1.2e6;
const eyeScale = (w, h) => Math.min(1, Math.sqrt(EYE_PIXEL_BUDGET / (w * h)));

const BLIT_WGSL = /* wgsl */ `
  struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
  }

  // UV comes from a varying, not from pixel coordinates: the pass renders
  // with visionOS's LOGICAL viewport (larger than the physical texture, the
  // hardware rate map compresses it), so fragment positions are not usable
  // as texel indices — but a varying interpolates 0..1 across the viewport
  // regardless of what space rasterization happens in.
  @vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    var out: VOut;
    out.pos = vec4f(p[i], 0, 1);
    out.uv = vec2f(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
    return out;
  }

  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;

  // three's AgX (renderers/shaders/tonemapping), transcribed TSL -> WGSL.
  fn agxContrast(x: vec3f) -> vec3f {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
      + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }

  fn agx(color: vec3f, exposure: f32) -> vec3f {
    let toRec2020 = mat3x3f(
      vec3f(0.6274, 0.0691, 0.0164),
      vec3f(0.3293, 0.9195, 0.0880),
      vec3f(0.0433, 0.0113, 0.8956));
    let toSrgb = mat3x3f(
      vec3f(1.6605, -0.1246, -0.0182),
      vec3f(-0.5876, 1.1329, -0.1006),
      vec3f(-0.0728, -0.0083, 1.1187));
    let inset = mat3x3f(
      vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
      vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
      vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859));
    let outset = mat3x3f(
      vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
      vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
      vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

    var c = toRec2020 * (color * exposure);
    c = inset * c;
    c = max(c, vec3f(1e-10));
    c = log2(c);
    c = (c - (-12.47393)) / (4.026069 - (-12.47393));
    c = clamp(c, vec3f(0.0), vec3f(1.0));
    c = agxContrast(c);
    c = outset * c;
    c = pow(max(vec3f(0.0), c), vec3f(2.2));
    c = toSrgb * c;
    return clamp(c, vec3f(0.0), vec3f(1.0));
  }

  fn srgbEncode(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
  }

  @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let c = textureSampleLevel(src, samp, uv, 0.0).rgb;
    return vec4f(srgbEncode(agx(c, EXPOSURE)), 1.0);
  }
`;

export default class ManualXROutput {
  /**
   * @param {import("three/webgpu").WebGPURenderer} renderer
   * @param {GPUDevice} device
   */
  constructor(renderer, device) {
    this.renderer = renderer;
    this.device = device;
    this.views = []; // per-frame: { texture: GPUTexture, desc: GPUTextureViewDescriptor }
    this.eyeRTs = [];
    this.pipelines = new Map(); // "format:WxH" -> GPURenderPipeline
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this._logged = false;
    // per-eye {srcTex, bindGroup} — rebuilt only when the eye RT's backing
    // texture changes, so steady-state frames allocate no GPU wrappers for
    // the source side
    this._bindCache = [];
    // heartbeat: proves in the remote log whether frames are flowing, and
    // how fast, right up to the moment the OS kills the page
    this._frames = 0;
    this._hbTime = 0;
    this._install();
  }

  // Replace three's sub-image collection: stash Apple's per-view textures
  // and descriptors for the blit, hand three physically-valid viewports for
  // its cameras, and return colorTexture: null so its external-texture
  // output path stays dormant.
  _install() {
    const xr = this.renderer.xr;

    // lifecycle breadcrumbs for the remote log
    xr.addEventListener("sessionstart", () => {
      window.shredLog?.("[xr] sessionstart");
      const session = xr.getSession();
      session?.addEventListener("visibilitychange", () =>
        window.shredLog?.(`[xr] visibility ${session.visibilityState}`)
      );
      session?.addEventListener("end", () => window.shredLog?.("[xr] session end event"));

      // visionOS's sub-images are foveated: physically 1888x1792 holding a
      // logically 4338x3478 view through a rasterization rate map WebGPU
      // can't see. Rendering uniform pixels into that texture warps the
      // world when the compositor un-warps it. Ask the layer for no
      // foveation; the sub-image geometry log will show whether WebKit
      // honors it.
      if (xr._glProjLayer && "fixedFoveation" in xr._glProjLayer) {
        xr._glProjLayer.fixedFoveation = 0;
        window.shredLog?.("[xr] fixedFoveation set to 0");
      } else {
        window.shredLog?.("[xr] no fixedFoveation attribute on projection layer");
      }

      // three calls session.updateRenderState({depthNear, depthFar}) on the
      // first frame (camera near/far differ from session defaults). Frame
      // delivery has died after exactly one frame in every configuration
      // tried on visionOS — consistent with that call REPLACING the render
      // state instead of merging it, wiping the projection layer; a session
      // with no layers gets no more animation frames. Re-assert the layer
      // on every call.
      if (session) {
        const originalURS = session.updateRenderState.bind(session);
        session.updateRenderState = (state = {}) => {
          if (!state.layers && xr._glProjLayer) {
            window.shredLog?.(
              `[xr] updateRenderState(${Object.keys(state).join(",")}) — re-asserting layers`
            );
            state = { ...state, layers: [xr._glProjLayer] };
          }
          return originalURS(state);
        };
      }
    });
    xr.addEventListener("sessionend", () => window.shredLog?.("[xr] sessionend"));

    // WebKit does not route exceptions from XRSession rAF callbacks to
    // window.onerror — a throw inside three's onAnimationFrame (pose
    // handling, controller/hand-joint updates — all of which run BEFORE the
    // user animation loop) kills every subsequent frame invisibly while the
    // pre-queued rAF keeps the dead loop spinning. Catch and stream it.
    const originalFrame = xr._onAnimationFrame;
    xr._onAnimationFrame = (time, frame) => {
      try {
        originalFrame(time, frame);
      } catch (err) {
        window.shredLog?.(
          `[xr] onAnimationFrame threw: ${err?.name}: ${err?.message}` +
            ` @ ${err?.stack?.split("\n")[1]?.trim() ?? "?"}`
        );
      }
    };
    xr._getWebGPUViewData = (views) => {
      const binding = xr.getWebGPUBinding();
      const viewData = { colorTexture: null, viewDescriptors: [], viewports: [] };
      this.views.length = 0;

      for (let i = 0; i < views.length; i++) {
        const sub = binding.getViewSubImage(xr._glProjLayer, views[i]);
        const c = sub.colorTexture;
        const vp = sub.viewport;
        const desc = sub.getViewDescriptor
          ? sub.getViewDescriptor()
          : { dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 };

        // clamp the logical (foveated) viewport onto the physical texture
        const overX = vp.x + vp.width;
        const overY = vp.y + vp.height;
        const sx = overX > c.width ? c.width / overX : 1;
        const sy = overY > c.height ? c.height / overY : 1;
        viewData.viewports.push({
          x: Math.floor(vp.x * sx),
          y: Math.floor(vp.y * sy),
          width: Math.floor(vp.width * sx),
          height: Math.floor(vp.height * sy),
        });

        this.views.push({
          texture: c,
          desc,
          // Apple's viewport, verbatim — logical coordinates, larger than
          // the physical texture; the blit passes it straight to
          // setViewport and the hardware rate map does the compression
          vp: { x: vp.x, y: vp.y, width: vp.width, height: vp.height },
        });
        // re-dump geometry whenever the sub-image size changes (e.g. when
        // foveation is toggled), not just once
        if (i === 0 && this._lastSig !== `${c.width}x${c.height}`) {
          this._lastSig = `${c.width}x${c.height}`;
          this._logged = false;
        }
        if (!this._logged) {
          window.shredLog?.(
            `[xr] v${i} ${c.width}x${c.height} ${c.format}` +
              ` vp ${vp.x},${vp.y},${vp.width},${vp.height} desc ${JSON.stringify(desc)}`
          );
        }
      }
      this._logged = true;
      return viewData;
    };
  }

  /**
   * Pre-compiles every material's XR-target pipeline (HalfFloat color, no
   * MSAA) by rendering one small offscreen frame. An on-device shader
   * compile mid-session stalls past visionOS's frame deadline and the OS
   * ends the session ("visible-blurred" then gone) — so everything that
   * appears lazily has to be forced through now: invisible meshes (the
   * summoned snowboard and its shadow) are shown for the warmup frame, and
   * the WebXR hand models (which don't exist until tracking starts) get a
   * stand-in with the same pipeline shape — instanced sphere, standard
   * material.
   */
  warmup(scene, camera) {
    const r = this.renderer;

    const hidden = [];
    scene.traverse((o) => {
      if (o.visible === false) {
        hidden.push(o);
        o.visible = true;
      }
    });
    const handProxy = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.01, 8, 6),
      new THREE.MeshStandardMaterial(),
      1
    );
    handProxy.frustumCulled = false;
    scene.add(handProxy);

    this._ensureEyeRT(0, 256, 256);
    r.setRenderTarget(this.eyeRTs[0]);
    r.render(scene, camera);
    r.setRenderTarget(null);

    scene.remove(handProxy);
    handProxy.geometry.dispose();
    handProxy.material.dispose();
    for (const o of hidden) o.visible = false;
  }

  /** Renders both eyes and presents them. Call instead of renderer.render. */
  render(scene, userCamera) {
    const r = this.renderer;
    r.xr.updateCamera(userCamera); // finalize per-eye matrixWorld / projection
    const cams = r.xr.getCamera().cameras;
    const n = Math.min(cams.length, this.views.length);
    if (n === 0) return;

    r.setOutputRenderTarget(null); // three's frame setup pointed it at its dead 0x0 target
    for (let i = 0; i < n; i++) {
      const v = this.views[i];
      const s = eyeScale(v.texture.width, v.texture.height);
      this._ensureEyeRT(
        i,
        Math.round(v.texture.width * s),
        Math.round(v.texture.height * s)
      );
      r.setRenderTarget(this.eyeRTs[i]);
      r.render(scene, cams[i]);
    }
    r.setRenderTarget(null);
    this._blit(n);

    const f = (this._totalFrames = (this._totalFrames || 0) + 1);
    if (f <= 3 || f === 10 || f === 30 || f === 90 || f === 300) {
      window.shredLog?.(`[hb] xr frame ${f} submitted`);
    }
    this._frames++;
    const now = performance.now();
    if (this._hbTime === 0) this._hbTime = now;
    if (now - this._hbTime > 3000) {
      const fps = (this._frames / ((now - this._hbTime) / 1000)).toFixed(1);
      window.shredLog?.(`[hb] xr frames flowing, ${fps} fps`);
      this._frames = 0;
      this._hbTime = now;
    }
  }

  _ensureEyeRT(i, width, height) {
    const existing = this.eyeRTs[i];
    if (existing && existing.width === width && existing.height === height) return;
    existing?.dispose();
    // HDR: the scene is radiometric (sun ~23x sky); AgX happens in the blit
    this.eyeRTs[i] = new THREE.RenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
  }

  _pipeline(format) {
    let pipeline = this.pipelines.get(format);
    if (pipeline) return pipeline;
    const module = this.device.createShaderModule({
      code: BLIT_WGSL.replace("EXPOSURE", this.renderer.toneMappingExposure.toFixed(4)),
    });
    pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.pipelines.set(format, pipeline);
    return pipeline;
  }

  _blit(n) {
    const backend = this.renderer.backend;
    const encoder = this.device.createCommandEncoder();

    for (let i = 0; i < n; i++) {
      const v = this.views[i];
      const srcTex = backend.get(this.eyeRTs[i].texture)?.texture;
      if (!srcTex) continue;

      const pipeline = this._pipeline(v.texture.format);
      let cached = this._bindCache[i];
      if (!cached || cached.srcTex !== srcTex) {
        cached = this._bindCache[i] = {
          srcTex,
          bindGroup: this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: srcTex.createView() },
              { binding: 1, resource: this.sampler },
            ],
          }),
        };
      }
      const bindGroup = cached.bindGroup;

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: v.texture.createView(v.desc), // Apple's own descriptor, verbatim
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setViewport(v.vp.x, v.vp.y, v.vp.width, v.vp.height, 0, 1);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }
}
