import * as THREE from "three";
import Experience from "../Experience.js";

// Gentle ambient snowfall around the carve field — CPU-updated point cloud
// (1000 flakes is trivial bandwidth, and staying off TSL here keeps the
// particle path identical on every backend). World-scaled 20x with the
// field: to the giant these are fat lazy flakes drifting past at
// centimetres per second of physical speed.

const COUNT = 1000;
const RANGE = 360; // xz extent, centered on the field
const TOP = 140; // fall height above BASE_Y
const BASE_Y = 20; // roughly the terrain around the field/rig
const CENTER = { x: 0, z: -140 };

export default class Snowfall {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.positions = new Float32Array(COUNT * 3);
    this.speeds = new Float32Array(COUNT);
    this.phases = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this.positions[i * 3 + 0] = CENTER.x + (Math.random() - 0.5) * RANGE;
      this.positions[i * 3 + 1] = BASE_Y + Math.random() * TOP;
      this.positions[i * 3 + 2] = CENTER.z + (Math.random() - 0.5) * RANGE;
      this.speeds[i] = (0.25 + Math.random() * 0.45) * 20;
      this.phases[i] = Math.random() * Math.PI * 2;
    }

    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.attribute);

    this.material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.28,
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
      if (y < BASE_Y) y += TOP;
      p[i * 3 + 1] = y;
      // lazy sideways drift
      p[i * 3 + 0] += Math.sin(this.elapsed * 0.8 + this.phases[i]) * dt * 1.2;
    }
    this.attribute.needsUpdate = true;
  }
}
