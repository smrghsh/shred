import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import Experience from "./Experience.js";

// WebGPU sibling of brahma's WebGL Renderer: same interface (instance /
// resize / update), but drives three's WebGPURenderer on the snow sim's
// GPUDevice so the state texture reaches the material with one GPU->GPU
// copy per frame and no CPU readback.
export default class Renderer {
  constructor(device) {
    this.experience = new Experience();
    this.canvas = this.experience.canvas;
    this.sizes = this.experience.sizes;
    this.scene = this.experience.scene;
    this.camera = this.experience.camera;

    // No MSAA on XR-capable devices: three's MSAA-for-WebXR-WebGPU path is
    // brand new (r186dev, Aug 2026) and unproven on visionOS; desktop keeps
    // antialiasing. Detection is async, so Experience.init passes it in.
    this.instance = new WebGPURenderer({
      canvas: this.canvas,
      device, // share the sim's GPUDevice
      antialias: !this.experience.xrSupported,
    });
    this.instance.setSize(this.sizes.width, this.sizes.height);
    this.instance.setPixelRatio(Math.min(this.sizes.pixelRatio, 2));
    this.instance.xr.enabled = true;
    // The sky solve produces real radiometric ratios (sun ~23x the sky);
    // AgX rolls that range off filmically — snowflow's pick, and most of why
    // its brights bloom instead of clipping.
    this.instance.toneMapping = THREE.AgXToneMapping;
    this.instance.toneMappingExposure = 0.27;
  }

  // WebGPURenderer requires async initialization before the first render.
  async init() {
    await this.instance.init();

    // three r185 sizes its XR depth texture once, from what
    // XRProjectionLayer.textureWidth/Height report at session start — but
    // visionOS hands back per-frame sub-images at a different size
    // (dynamic viewport scaling), and WebKit then rejects every render
    // pass with "depth stencil texture dimensions mismatch". Resize the
    // XR render target to the actual color texture before three
    // (re)builds the depth attachment for the frame. Remove when three's
    // WebGPU XR path tracks sub-image dimensions itself.
    // Replaces three's _getWebGPUViewData wholesale. visionOS deviates from
    // the WebXR-WebGPU spec draft in ways r186dev doesn't handle:
    // the projection layer reports textureWidth/Height of 0 (three builds a
    // 0x0 render target from it), and the sub-image viewport is the LOGICAL
    // foveated resolution — larger than the physical texture, which
    // invalidates any pass that sets it (WebKit then only reports the
    // downstream "encoder state is 'Locked'" when finish() runs). So:
    // clamp viewports onto the physical texture, resize the render target
    // to the real sub-image, and dump the full per-view geometry to the
    // on-page log once, so device behavior is never a guess again.
    const xr = this.instance.xr;
    let loggedXR = false;
    xr._getWebGPUViewData = (views) => {
      const binding = xr.getWebGPUBinding();
      const viewData = { colorTexture: null, viewDescriptors: [], viewports: [] };
      const details = [];

      for (let i = 0; i < views.length; i++) {
        const sub = binding.getViewSubImage(xr._glProjLayer, views[i]);
        const c = sub.colorTexture;
        const d = sub.depthStencilTexture;
        const vp = sub.viewport;
        const desc = sub.getViewDescriptor ? sub.getViewDescriptor() : null;

        if (!loggedXR) {
          details.push(
            `[xr] v${i} c ${c.width}x${c.height}x${c.depthOrArrayLayers} ${c.format}` +
              `${i > 0 ? ` sameTex:${c === viewData.colorTexture}` : ""}` +
              ` d ${d ? `${d.width}x${d.height}x${d.depthOrArrayLayers} ${d.format}` : "none"}` +
              ` vp ${vp.x},${vp.y},${vp.width},${vp.height}` +
              ` desc ${desc ? JSON.stringify(desc) : "none"}`
          );
        }

        if (viewData.colorTexture === null) viewData.colorTexture = c;

        // clamp the logical (foveated) viewport onto the physical texture;
        // a no-op on platforms whose viewports already fit
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

        if (desc) viewData.viewDescriptors.push(desc);
      }

      const tex = viewData.colorTexture;
      const rt = xr._xrRenderTarget;
      if (!loggedXR && tex) {
        loggedXR = true;
        details.push(
          `[xr] layer ${xr._glProjLayer?.textureWidth}x${xr._glProjLayer?.textureHeight}` +
            ` scale ${binding.nativeProjectionScaleFactor?.toFixed?.(3)}` +
            ` rt ${rt?.width}x${rt?.height}x${rt?.depth} samples ${this.instance.samples}`
        );
        for (const line of details) window.shredLog?.(line);
      }
      if (
        tex &&
        rt &&
        (rt.width !== tex.width ||
          rt.height !== tex.height ||
          rt.depth !== tex.depthOrArrayLayers)
      ) {
        rt.setSize(tex.width, tex.height, tex.depthOrArrayLayers);
      }
      return viewData;
    };
  }

  resize() {
    this.instance.setSize(this.sizes.width, this.sizes.height);
    this.instance.setPixelRatio(Math.min(this.sizes.pixelRatio, 2));
  }

  update() {
    this.instance.render(this.scene, this.camera.instance);
  }
}
