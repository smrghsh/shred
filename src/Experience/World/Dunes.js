import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { Fn, floor, fract, dot, normalLocal, normalize, positionWorld, sin, smoothstep, vec2, vec3, vec4 } from "three/tsl";
import Experience from "../Experience.js";
import createSnowLighting from "../../sky/snowLighting.js";
import { SKY } from "../../sky/SkyLut.js";
import { terrainMacro } from "../../terrain/terrainMacro.js";
import { SNOW_Y, SLOPE_GRADE, surfaceY } from "./constants.js";
import { FIELD_SIZE } from "../../snow/SnowSim.js";

// The mountainside between the carvable patch and the raymarched far range:
// snowflow_demo's terrainMacro landform (wind-anisotropic, derivative-damped
// fBm) displacing a polar grid, baked once on the CPU. The whole grid rides
// the base slope the carve field tilts with; beyond the field the flank
// steepens uphill (-Z) toward the peak and eases downhill into the
// fog-filled valley, with the dune landform arriving within a few metres of
// the field edge so the grade is unmissable from the spawn.

// Uphill flank: quadratic steepening from the spawn grade (0.2) to ~0.84
// at the rim — the crest tops out around 400 m and owns the skyline (the
// raymarched far range caps at ~13 degrees elevation, so no bake can put
// peaks above it; the mesh has to be the mountain).
const FLANK = 0.0004;
// Downhill: the run eases toward a valley floor. The scale is chosen to
// keep the 800 m rim above ~-35 m, so the far range across the valley
// still plants its feet behind the mesh instead of floating on a strip of
// bright LUT sky (the sky dome only draws the range above -0.05 elevation).
const VALLEY = 220;

// dense enough that the crest silhouette at 800 m is drawn from ~25 m
// triangles, not 60 m ones — the peaks live or die on their skyline
const ANGULAR = 256;
const RINGS = 120;
const R_INNER = 2.0; // hole hidden under the opaque carve field
const R_OUTER = 800;

export default class Dunes {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.skyLut = this.experience.skyLut;

    const windRad = (SKY.windDirection * Math.PI) / 180;
    const half = FIELD_SIZE / 2;

    const positions = new Float32Array((RINGS + 1) * ANGULAR * 3);
    const indices = [];
    const growth = Math.pow(R_OUTER / R_INNER, 1 / RINGS);

    let v = 0;
    for (let i = 0; i <= RINGS; i++) {
      const r = R_INNER * Math.pow(growth, i);
      for (let j = 0; j < ANGULAR; j++) {
        const a = (j / ANGULAR) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;

        // planar (a hair below the carve field, hiding the seam) at the
        // patch, then the landform arrives fast: hip-high drifts right off
        // the field edge, the full +/-20 m terrainMacro within a hundred
        // metres — snowflow spawns you on full-amplitude terrain, and
        // holding it back to the far distance is what read as a flat plain
        const blend = THREE.MathUtils.smoothstep(r, half * 1.3, 25);
        const uphill = Math.max(0, -z);
        const downhill = Math.max(0, z);
        const shaped =
          SNOW_Y +
          SLOPE_GRADE * uphill +
          FLANK * uphill * uphill -
          (SLOPE_GRADE * downhill) / (1 + downhill / VALLEY);
        let h =
          THREE.MathUtils.lerp(surfaceY(x, z), shaped, blend) -
          0.004 * (1 - blend);

        // relief grows with altitude — the dune-scale landform down here,
        // serrated alpine crests up on the flank — so the skyline reads as
        // peaks rather than as the same dunes farther away
        const alpine = 1 + Math.max(0, shaped - SNOW_Y) * 0.006;
        const amp =
          blend * (0.25 + 0.75 * THREE.MathUtils.smoothstep(r, 20, 110)) * alpine;
        if (amp > 0) h += terrainMacro(x, z, windRad) * amp;

        positions[v * 3 + 0] = x;
        positions[v * 3 + 1] = h;
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
