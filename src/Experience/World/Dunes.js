import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { Fn, floor, fract, dot, normalLocal, normalize, positionWorld, sin, smoothstep, vec2, vec3, vec4 } from "three/tsl";
import Experience from "../Experience.js";
import createSnowLighting from "../../sky/snowLighting.js";
import { terrainSurfaceY } from "../../terrain/terrainSurface.js";
import { FIELD_CENTER } from "./constants.js";

// The mountainside: terrainSurface.js's landform (spawn-grade plane
// steepening uphill into the peak flank, easing downhill into the valley,
// snowflow's terrainMacro relief growing with altitude) displacing a polar
// grid, baked once on the CPU. The carve field conforms to the exact same
// function and floats a hair above this mesh, so the two agree everywhere.

// The polar grid is centered on the CARVE FIELD, not the world origin: the
// giant stands right there, and the exponential ring spacing then puts
// sub-metre triangles at their feet (where centimetre-scale facets were
// reading as clipping against the exact carve field) and ~20 m triangles
// out at the crest, which only has to hold a skyline.
const ANGULAR = 512;
const RINGS = 160;
const R_INNER = 0.5; // hidden under the carve field
const R_OUTER = 800;

export default class Dunes {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.skyLut = this.experience.skyLut;

    const positions = new Float32Array((RINGS + 1) * ANGULAR * 3);
    const indices = [];
    const growth = Math.pow(R_OUTER / R_INNER, 1 / RINGS);

    let v = 0;
    for (let i = 0; i <= RINGS; i++) {
      const r = R_INNER * Math.pow(growth, i);
      for (let j = 0; j < ANGULAR; j++) {
        const a = (j / ANGULAR) * Math.PI * 2;
        const x = FIELD_CENTER.x + Math.cos(a) * r;
        const z = FIELD_CENTER.z + Math.sin(a) * r;

        positions[v * 3 + 0] = x;
        positions[v * 3 + 1] = terrainSurfaceY(x, z);
        positions[v * 3 + 2] = z;
        v++;
      }
    }
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < ANGULAR; j++) {
        const j1 = (j + 1) % ANGULAR;
        const a = i * ANGULAR + j;
        const b = i * ANGULAR + j1;
        const c = (i + 1) * ANGULAR + j;
        const d = (i + 1) * ANGULAR + j1;
        indices.push(a, b, c, b, d, c); // wound so faces point up (+y)
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setIndex(indices);
    this.geometry.computeVertexNormals();

    const lighting = createSnowLighting(this.skyLut);
    const albedo = vec3(0.855, 0.885, 0.945); // match the carve field's base

    this.material = new MeshBasicNodeMaterial();
    const hash2 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
    this.material.colorNode = Fn(() => {
      // normal grain at two scales — same trick as the carve field, so the
      // flat ring around it isn't a dead sheet and the seam disappears
      const g1 = hash2(floor(positionWorld.xz.mul(140))).sub(0.5);
      const g2 = hash2(floor(positionWorld.xz.mul(140)).add(7.3)).sub(0.5);
      const g3 = hash2(floor(positionWorld.xz.mul(9))).sub(0.5);
      const n = normalize(
        normalize(normalLocal).add(
          vec3(g1.mul(0.13).add(g3.mul(0.07)), 0, g2.mul(0.13).add(g3.mul(0.05)))
        )
      );
      const grain = hash2(floor(positionWorld.xz.mul(3.1))).mul(0.06).sub(0.03);
      const col = lighting.shadeSnow(albedo.add(grain), n, positionWorld);
      return vec4(lighting.applyAerial(col, positionWorld), 1);
    })();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // one draw; the far half is always in view anyway
    this.scene.add(this.mesh);
  }
}
