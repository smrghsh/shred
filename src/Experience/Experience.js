import * as THREE from "three";
import { Debug, Sizes, Camera } from "./brahma/Brahma.js";
import EventEmitter from "./brahma/utilities/EventEmitter.js";
import Resources from "./brahma/utilities/Resources.js";
import Renderer from "./Renderer.js";
import World from "./World/World.js";
import Hands from "../interaction/Hands.js";
import MouseCarve from "../interaction/MouseCarve.js";
import SkyLut from "../sky/SkyLut.js";
import sources from "./sources.js";
import { MAX_BRUSHES } from "../snow/SnowSim.js";

let instance = null;

// The WebGPURenderer needs an async init, so construction is split (the caye
// pattern): `new Experience(canvas)` wires the cheap synchronous pieces, then
// `await experience.init({ device, sim })` builds renderer/world and starts
// the loop. XR sessions are created with the "webgpu" session feature —
// shipped on-by-default in visionOS 26 Safari 26.2, which is the target
// device for this experience.
export default class Experience extends EventEmitter {
  constructor(canvas) {
    super();

    // Singleton pattern
    if (instance) {
      return instance;
    }
    instance = this;
    window.experience = this;

    this.canvas = canvas;
    this.debug = new Debug();
    if (this.debug.active && window.location.hash !== "#debug") {
      this.debug.ui.hide();
    }
    this.selectableObjects = [];

    // Brahma's Controller talks to experience.pointer; keep the no-op stub
    // (carving input is handled by Hands / MouseCarve directly).
    this.pointer = { setSource: () => {}, hover: () => {}, select: () => {} };

    this.sizes = new Sizes();
    this.scene = new THREE.Scene();
    this.resources = new Resources(sources);
    this.cameraGroup = new THREE.Group();
    this.scene.add(this.cameraGroup);

    this.camera = new Camera();
    // Desktop framing: head height at the downhill edge of the field,
    // looking up the slope — carve field in the lower half, the drift band
    // and climbing flank above it, crest and sky at the top (brahma's
    // default is a generic close-up). The 35-degree FOV can't hold both
    // the field at your feet and the ~27-degree crest, so the field's
    // downhill half is deliberately cropped.
    this.camera.instance.position.set(0.3, 1.9, 6.5);
    this.camera.instance.updateProjectionMatrix();
    this.camera.controls.target.set(0, 3.3, -1.5);
    this.camera.controls.maxPolarAngle = Math.PI * 0.49;
    this.camera.controls.maxDistance = 30;
    // The left button belongs to carving (MouseCarve) — orbit with the
    // right button, zoom with the wheel. No enabled-toggling handshake.
    this.camera.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.camera.controls.update();

    // Emitters (Hands, MouseCarve) push brush stamps here; the sim drains
    // the queue once per frame.
    this.brushQueue = [];
  }

  async init({ device, sim }) {
    this.device = device;
    this.sim = sim;

    this.renderer = new Renderer(device);
    await this.renderer.init();

    // Solve the sky before building the world: every snow material reads the
    // LUT + SH this produces, and the ground-bounce iteration needs the
    // renderer but nothing from the scene.
    this.skyLut = new SkyLut(this.renderer.instance);
    await this.skyLut.solve();

    this.world = new World();

    // Render one frame before accepting input: the first render switches the
    // camera to the WebGPU coordinate system (projection matrix changes), and
    // raycasts made before that would disagree with all later ones.
    this.camera.update();
    this.cameraGroup.updateMatrixWorld();
    this.camera.instance.updateMatrixWorld();
    this.world.update(0);
    this.renderer.update();

    this.hands = new Hands();
    this.mouseCarve = new MouseCarve();

    this.sizes.on("resize", () => {
      this.camera.resize();
      this.renderer.resize();
    });

    // Drive the loop through the renderer (not window.requestAnimationFrame,
    // which stops firing inside immersive XR sessions — three reroutes
    // setAnimationLoop to the XRSession's frame callback).
    this.time = { delta: 16, elapsed: 0 };
    this._lastFrameTime = performance.now();
    this.renderer.instance.setAnimationLoop(() => this.update());
  }

  update() {
    const now = performance.now();
    this.time.delta = now - this._lastFrameTime;
    this._lastFrameTime = now;
    this.time.elapsed += this.time.delta;
    const dt = Math.min(this.time.delta / 1000, 0.1);

    // --- interaction: emitters queue brush stamps for this frame ---
    this.hands.update(dt);
    this.mouseCarve.update(dt);

    // --- advance the snow state (relax + splat), then hand off to render ---
    // Consume at most one dispatch worth of brushes; the rest stay queued
    // for the next frame (a long compile-stall frame can bank dozens).
    this.sim.step(this.brushQueue.splice(0, MAX_BRUSHES), dt);

    // OrbitControls writes the camera pose every frame; in XR the headset
    // owns it, so let the controls idle while presenting.
    if (!this.isXRActive()) this.camera.update();
    this.cameraGroup.updateMatrixWorld();
    this.camera.instance.updateMatrixWorld();
    this.world.update(dt);
    this.renderer.update();
  }

  isXRActive() {
    return this.renderer?.instance.xr.isPresenting === true;
  }
}
