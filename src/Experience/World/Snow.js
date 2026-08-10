import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn,
  clamp,
  dot,
  float,
  floor,
  fract,
  int,
  ivec2,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  textureLoad,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import Experience from "../Experience.js";
import createSnowLighting from "../../sky/snowLighting.js";
import { FIELD_SIZE, FIELD_TEX, MAX_DEPTH } from "../../snow/SnowSim.js";
import { SNOW_Y, SLOPE_GRADE } from "./constants.js";

// The carvable snowfield. Every frame the sim's state texture (dep, berm,
// compression) is GPU-copied into a three-owned texture; the material
// displaces vertices by (berm - dep) and shades trenches with packed-snow
// darkening, blue "snow cave" occlusion, bright chunky berms, and sparkle.
// Around it, an effectively-infinite flat plane (with a hole where the field
// sits) carries the same base shading out to the fog line.

const SEGMENTS = 320; // ~1.9 cm vertex spacing over the 6 m field

export default class Snow {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.sim = this.experience.sim;
    this.device = this.experience.device;
    this.renderer = this.experience.renderer.instance;

    // three-owned copy of the sim state (rgba32float, not filterable without
    // extra device features — all reads are textureLoad, bilinear by hand)
    this.stateTex = new THREE.DataTexture(
      new Float32Array(FIELD_TEX * FIELD_TEX * 4),
      FIELD_TEX,
      FIELD_TEX,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.stateTex.magFilter = THREE.NearestFilter;
    this.stateTex.minFilter = THREE.NearestFilter;
    this.stateTex.generateMipmaps = false;
    this.stateTex.needsUpdate = true;
    this.renderer.initTexture(this.stateTex); // force backend allocation for copies

    const stateTex = this.stateTex;
    const N = FIELD_TEX;

    // world xz -> texel index (unclamped float texel space)
    const texelOf = (wx, wz) =>
      vec2(
        wx.div(float(FIELD_SIZE)).add(0.5).mul(float(N)).sub(0.5),
        wz.div(float(FIELD_SIZE)).add(0.5).mul(float(N)).sub(0.5)
      );

    const loadState = (tx, ty) =>
      textureLoad(
        stateTex,
        ivec2(
          clamp(int(tx), int(0), int(N - 1)),
          clamp(int(ty), int(0), int(N - 1))
        )
      );

    // manual bilinear fetch of the full state vector
    const sampleState = Fn(([wx, wz]) => {
      const t = texelOf(wx, wz);
      const t0 = floor(t);
      const f = fract(t);
      const s00 = loadState(t0.x, t0.y);
      const s10 = loadState(t0.x.add(1), t0.y);
      const s01 = loadState(t0.x, t0.y.add(1));
      const s11 = loadState(t0.x.add(1), t0.y.add(1));
      return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
    });

    // the mountainside base plane the sim state rides on (mesh sits at
    // SNOW_Y, so only the tilt term lives here); baked into both height
    // functions so displacement and normals agree about the slope
    const baseAt = (wz) => wz.mul(float(-SLOPE_GRADE));

    // surface offset = base + berm - depression
    const heightAt = (wx, wz) => {
      const s = sampleState(wx, wz);
      return s.y.sub(s.x).add(baseAt(wz));
    };

    // nearest-tap height for gradients (diffusion keeps the field smooth
    // enough that the 4 extra bilinear fetches aren't worth the bandwidth
    // on the headset)
    const heightNearest = (wx, wz) => {
      const t = texelOf(wx, wz);
      const s = loadState(t.x.add(0.5), t.y.add(0.5));
      return s.y.sub(s.x).add(baseAt(wz));
    };

    const hash2 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
    const lighting = createSnowLighting(this.experience.skyLut);
    const skyLut = this.experience.skyLut;

    this.material = new MeshBasicNodeMaterial();

    this.material.positionNode = vec3(
      positionLocal.x,
      heightAt(positionLocal.x, positionLocal.z),
      positionLocal.z
    );

    const shade = Fn(() => {
      const wx = positionLocal.x;
      const wz = positionLocal.z;
      const s = sampleState(wx, wz);
      const dep = s.x;
      const berm = s.y;
      const comp = s.z;

      // normal from central differences, two texels wide
      const e = float((FIELD_SIZE / FIELD_TEX) * 2);
      const hE = heightNearest(wx.add(e), wz);
      const hW = heightNearest(wx.sub(e), wz);
      const hN = heightNearest(wx, wz.add(e));
      const hS = heightNearest(wx, wz.sub(e));
      const nrm = normalize(
        vec3(hW.sub(hE), e.mul(2), hS.sub(hN))
      );

      // fine grain in the normal so flat snow shimmers warm/cool instead of
      // rendering as one uniform tone (the fine-detail role snowflow's
      // sastrugi + ripple layers play)
      const g1 = hash2(floor(vec2(wx, wz).mul(140))).sub(0.5);
      const g2 = hash2(floor(vec2(wx, wz).mul(140)).add(7.3)).sub(0.5);
      const g3 = hash2(floor(vec2(wx, wz).mul(28))).sub(0.5);
      const nrmDetail = normalize(
        nrm.add(vec3(g1.mul(0.13).add(g3.mul(0.07)), 0, g2.mul(0.13).add(g3.mul(0.05))))
      );

      // --- albedo from surface state (snowflow's palette) ---
      const base = vec3(0.855, 0.885, 0.945);
      const packed = vec3(0.62, 0.665, 0.755); // trench floor, dense snow
      const loose = vec3(0.895, 0.92, 0.965); // thrown berm chunks, bright
      const albedo = mix(base, packed, clamp(comp, 0, 1).mul(0.85)).toVar();
      const bermMask = smoothstep(float(0.002), float(0.02), berm);
      albedo.assign(mix(albedo, loose, bermMask));
      // chunky granulation on the berms so thrown snow reads as clumps
      const chunk = hash2(floor(vec2(wx, wz).mul(90)));
      albedo.assign(albedo.mul(bermMask.mul(chunk).mul(0.16).oneMinus()));

      // --- one light for the whole scene: baked sun radiance + SH sky ---
      const col = lighting.shadeSnow(albedo, nrmDetail, positionWorld).toVar();

      // --- trench occlusion with the blue "snow cave" tint, applied to the
      // total radiance (snowflow's trick — the ambient is where the blue
      // lives, and occluding only it would leave brown trenches) ---
      const occ = clamp(dep.mul(2 / MAX_DEPTH), 0, 1).mul(0.5);
      const cave = mix(vec3(1), vec3(0.58, 0.72, 1.0), occ.mul(0.95));
      col.assign(col.mul(cave).mul(occ.mul(0.5).oneMinus()));

      // --- sparkle: sparse specks that fire under direct sun ---
      const sunNdl = clamp(dot(nrm, vec3(skyLut.uSunDir)), 0, 1);
      const glint = smoothstep(
        float(0.985),
        float(1.0),
        hash2(floor(vec2(wx, wz).mul(240)))
      );
      const sparkle = vec3(skyLut.uSunRadiance)
        .mul(glint.mul(sunNdl).mul(0.12));

      return vec4(col.add(sparkle), 1);
    });
    this.material.colorNode = shade();

    this.geometry = new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE, SEGMENTS, SEGMENTS);
    this.geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.y = SNOW_Y;
    this.mesh.frustumCulled = false; // vertices move on the GPU
    this.scene.add(this.mesh);
  }

  // GPU->GPU copy of the live sim state into the three-owned texture.
  update() {
    const backend = this.renderer.backend;
    const gpuTex = backend.get(this.stateTex).texture;
    if (!gpuTex) return;
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: this.sim.texture },
      { texture: gpuTex },
      { width: FIELD_TEX, height: FIELD_TEX, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([encoder.finish()]);
  }
}
