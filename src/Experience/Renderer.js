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

    this.instance = new WebGPURenderer({
      canvas: this.canvas,
      device, // share the sim's GPUDevice
      antialias: true,
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
  }

  resize() {
    this.instance.setSize(this.sizes.width, this.sizes.height);
    this.instance.setPixelRatio(Math.min(this.sizes.pixelRatio, 2));
  }

  update() {
    this.instance.render(this.scene, this.camera.instance);
  }
}
