import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import Experience from "./Experience.js";
import ManualXROutput from "./xr/ManualXROutput.js";

// WebGPU sibling of brahma's WebGL Renderer: same interface (instance /
// resize / update), but drives three's WebGPURenderer on the snow sim's
// GPUDevice so the state texture reaches the material with one GPU->GPU
// copy per frame and no CPU readback.
export default class Renderer {
  constructor(device) {
    this.experience = new Experience();
    this.device = device;
    this.canvas = this.experience.canvas;
    this.sizes = this.experience.sizes;
    this.scene = this.experience.scene;
    this.camera = this.experience.camera;

    // No MSAA on XR-capable devices: while presenting, eyes render through
    // ManualXROutput's plain render targets; desktop keeps antialiasing.
    // Detection is async, so Experience.init resolves it beforehand.
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
    // its brights bloom instead of clipping. ManualXROutput mirrors this
    // exact curve in its blit shader, because render-target passes bypass
    // the renderer's output transform.
    this.instance.toneMapping = THREE.AgXToneMapping;
    this.instance.toneMappingExposure = 0.27;
  }

  // WebGPURenderer requires async initialization before the first render.
  async init() {
    await this.instance.init();

    // visionOS's WebXR-WebGPU sub-images break three's native XR output
    // path (see ManualXROutput for the full autopsy); this replaces the
    // presentation half while keeping three's session/pose machinery.
    this.manualXR = new ManualXROutput(this.instance, this.device);
  }

  resize() {
    this.instance.setSize(this.sizes.width, this.sizes.height);
    this.instance.setPixelRatio(Math.min(this.sizes.pixelRatio, 2));
  }

  update() {
    if (this.instance.xr.isPresenting) {
      // distinguishes "main loop dead" / "no view data" / "render dead"
      // in the remote log — visionOS sessions were dying silently
      const t = (this._xrTicks = (this._xrTicks || 0) + 1);
      if (t <= 3 || t === 10 || t === 30 || t === 90 || t === 300) {
        window.shredLog?.(`[hb] tick ${t} views ${this.manualXR.views.length}`);
      }
    } else {
      this._xrTicks = 0;
    }
    if (this.instance.xr.isPresenting && this.manualXR.views.length > 0) {
      this.manualXR.render(this.scene, this.camera.instance);
    } else {
      this.instance.render(this.scene, this.camera.instance);
    }
  }
}
