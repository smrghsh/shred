import * as THREE from "three";
import Experience from "../Experience.js";

// Gentle ambient snowfall around the player — CPU-updated point cloud
// (1000 flakes is trivial bandwidth, and staying off TSL here keeps the
// particle path identical on every backend).

const COUNT = 1000;
const RANGE = 18; // xz extent
const TOP = 7;

export default class Snowfall {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.positions = new Float32Array(COUNT * 3);
    this.speeds = new Float32Array(COUNT);
    this.phases = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this.positions[i * 3 + 0] = (Math.random() - 0.5) * RANGE;
      this.positions[i * 3 + 1] = Math.random() * TOP;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * RANGE;
      this.speeds[i] = 0.25 + Math.random() * 0.45;
      this.phases[i] = Math.random() * Math.PI * 2;
    }

    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.attribute);

    this.material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.014,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.elapsed = 0;
  }

  update(dt) {
    this.elapsed += dt;
    const p = this.positions;
    for (let i = 0; i < COUNT; i++) {
      let y = p[i * 3 + 1] - this.speeds[i] * dt;
      if (y < 0) y += TOP;
      p[i * 3 + 1] = y;
      // lazy sideways drift
      p[i * 3 + 0] += Math.sin(this.elapsed * 0.8 + this.phases[i]) * dt * 0.06;
    }
    this.attribute.needsUpdate = true;
  }
}
