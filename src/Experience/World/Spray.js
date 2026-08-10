import * as THREE from "three";
import Experience from "../Experience.js";
import { surfaceY } from "./constants.js";

// Snow spray kicked up while carving: a small CPU particle pool rendered as
// points. Emitters call spray.emit(origin, velocity, count); particles fly
// ballistically and die when they fall back to the surface.

const POOL = 384;
const GRAVITY = -3.2; // gentler than earth — powder floats

export default class Spray {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.positions = new Float32Array(POOL * 3);
    this.velocities = new Float32Array(POOL * 3);
    this.lives = new Float32Array(POOL); // seconds remaining, <= 0 = dead
    this.count = 0; // alive particles, compacted to the front

    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.attribute);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({
      color: 0xf4f8ff,
      size: 0.011,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  emit(origin, baseVel, count) {
    for (let i = 0; i < count; i++) {
      if (this.count >= POOL) return;
      const j = this.count++;
      this.positions[j * 3 + 0] = origin.x + (Math.random() - 0.5) * 0.03;
      this.positions[j * 3 + 1] = origin.y + Math.random() * 0.02;
      this.positions[j * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.03;
      this.velocities[j * 3 + 0] = baseVel.x * (0.6 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.3;
      this.velocities[j * 3 + 1] = Math.abs(baseVel.y) + 0.4 + Math.random() * 0.7;
      this.velocities[j * 3 + 2] = baseVel.z * (0.6 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.3;
      this.lives[j] = 0.5 + Math.random() * 0.6;
    }
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.lives[i] -= dt;
      const dead =
        this.lives[i] <= 0 ||
        (this.positions[i * 3 + 1] <
          surfaceY(this.positions[i * 3], this.positions[i * 3 + 2]) - 0.02 &&
          this.velocities[i * 3 + 1] < 0);
      if (dead) {
        // swap-remove with the last alive particle
        const last = --this.count;
        for (let k = 0; k < 3; k++) {
          this.positions[i * 3 + k] = this.positions[last * 3 + k];
          this.velocities[i * 3 + k] = this.velocities[last * 3 + k];
        }
        this.lives[i] = this.lives[last];
        continue;
      }
      this.velocities[i * 3 + 1] += GRAVITY * dt;
      this.positions[i * 3 + 0] += this.velocities[i * 3 + 0] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      i++;
    }
    this.geometry.setDrawRange(0, this.count);
    this.attribute.needsUpdate = true;
  }
}
