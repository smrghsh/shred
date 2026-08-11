import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn,
  attribute,
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
import { FIELD_CENTER, FIELD_LIFT } from "./constants.js";
import { terrainSurfaceY } from "../../terrain/terrainSurface.js";

// The carvable snowfield, draped over the mountainside: a 120 m patch of
// the flank uphill of the giant's stance. The terrain height is baked into
// the vertices on the CPU (same function the dune mesh uses, lifted a hair
// so the two never fight); every frame the sim's state texture (dep, berm,
// compression) is GPU-copied into a three-owned texture and the material
// displaces vertices by (berm - dep) on top of the baked ground, shading
// trenches with packed-snow darkening, blue "snow cave" occlusion, bright
// chunky berms, and sparkle.

const SEGMENTS = 400; // ~30 cm vertex spacing over the 120 m field

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

    // field-local xz -> texel index (unclamped float texel space)
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

    // sim surface offset = berm - depression (the baked terrain lives in
    // the vertex positions, not here)
    const offsetAt = (wx, wz) => {
      const s = sampleState(wx, wz);
      return s.y.sub(s.x);
    };

    // nearest-tap offset for gradients (diffusion keeps the field smooth
    // enough that the 4 extra bilinear fetches aren't worth the bandwidth
    // on the headset)
    const offsetNearest = (wx, wz) => {
      const t = texelOf(wx, wz);
      const s = loadState(t.x.add(0.5), t.y.add(0.5));
      return s.y.sub(s.x);
    };

    const hash2 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
    const lighting = createSnowLighting(this.experience.skyLut);
    const skyLut = this.experience.skyLut;

    this.material = new MeshBasicNodeMaterial();

    // vertices carry the baked mountainside in y; the sim rides on top
    this.material.positionNode = vec3(
      positionLocal.x,
      positionLocal.y.add(offsetAt(positionLocal.x, positionLocal.z)),
      positionLocal.z
    );

    const shade = Fn(() => {
      const wx = positionLocal.x;
      const wz = positionLocal.z;
      const s = sampleState(wx, wz);
      const dep = s.x;
      const berm = s.y;
      const comp = s.z;

      // baked terrain normal perturbed by the sim's height gradient
      const e = float((FIELD_SIZE / FIELD_TEX) * 2);
      const hE = offsetNearest(wx.add(e), wz);
      const hW = offsetNearest(wx.sub(e), wz);
      const hN = offsetNearest(wx, wz.add(e));
      const hS = offsetNearest(wx, wz.sub(e));
      const baseN = normalize(attribute("baseNormal", "vec3"));
      const nrm = normalize(
        baseN.add(vec3(hW.sub(hE).div(e.mul(2)), 0, hS.sub(hN).div(e.mul(2))))
      );

      // fine grain in the normal so flat snow shimmers warm/cool instead of
      // rendering as one uniform tone (frequencies are 1/20th of the old
      // 6 m field's — same physical wavelength at the giant's eye)
      const g1 = hash2(floor(vec2(wx, wz).mul(7))).sub(0.5);
      const g2 = hash2(floor(vec2(wx, wz).mul(7)).add(7.3)).sub(0.5);
      const g3 = hash2(floor(vec2(wx, wz).mul(1.4))).sub(0.5);
      const nrmDetail = normalize(
        nrm.add(vec3(g1.mul(0.13).add(g3.mul(0.07)), 0, g2.mul(0.13).add(g3.mul(0.05))))
      );

      // --- albedo from surface state (snowflow's palette) ---
      const base = vec3(0.855, 0.885, 0.945);
      const packed = vec3(0.62, 0.665, 0.755); // trench floor, dense snow
      const loose = vec3(0.895, 0.92, 0.965); // thrown berm chunks, bright
      const albedo = mix(base, packed, clamp(comp, 0, 1).mul(0.85)).toVar();
      const bermMask = smoothstep(float(0.04), float(0.4), berm);
      albedo.assign(mix(albedo, loose, bermMask));
      // chunky granulation on the berms so thrown snow reads as clumps
      const chunk = hash2(floor(vec2(wx, wz).mul(4.5)));
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
        hash2(floor(vec2(wx, wz).mul(12)))
      );
      const sparkle = vec3(skyLut.uSunRadiance)
        .mul(glint.mul(sunNdl).mul(0.12));

      return vec4(col.add(sparkle), 1);
    });
    this.material.colorNode = shade();

    this.geometry = this._buildGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(FIELD_CENTER.x, 0, FIELD_CENTER.z);
    this.mesh.frustumCulled = false; // vertices move on the GPU
    this.scene.add(this.mesh);
  }

  // Field-local grid with the mountainside baked into vertex y (plus the
  // lift over the dune mesh) and the terrain normal in an attribute — the
  // sim only ever adds its offset on top.
  _buildGeometry() {
    const geometry = new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);

    const pos = geometry.attributes.position;
    const normals = new Float32Array(pos.count * 3);
    const eps = FIELD_SIZE / SEGMENTS;
    for (let i = 0; i < pos.count; i++) {
      const wx = FIELD_CENTER.x + pos.getX(i);
      const wz = FIELD_CENTER.z + pos.getZ(i);
      pos.setY(i, terrainSurfaceY(wx, wz) + FIELD_LIFT);

      const hx = terrainSurfaceY(wx + eps, wz) - terrainSurfaceY(wx - eps, wz);
      const hz = terrainSurfaceY(wx, wz + eps) - terrainSurfaceY(wx, wz - eps);
      const inv = 1 / Math.hypot(hx / (2 * eps), 1, hz / (2 * eps));
      normals[i * 3 + 0] = (-hx / (2 * eps)) * inv;
      normals[i * 3 + 1] = 1 * inv;
      normals[i * 3 + 2] = (-hz / (2 * eps)) * inv;
    }
    geometry.setAttribute("baseNormal", new THREE.BufferAttribute(normals, 3));
    return geometry;
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
