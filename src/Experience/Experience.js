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
import { GIANT_SCALE, RIG_XZ } from "./World/constants.js";
import { terrainSurfaceY } from "../terrain/terrainSurface.js";

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
    // Desktop framing: hovering above the mountainside at the giant's
    // vantage — the carve field on the flank below, the crest above.
    // (Heights computed from the shared terrain function at init, since
    // the field sits partway up the flank now.)
    this.camera.instance.far = 5000;
    this.camera.instance.position.set(8, 75, -55);
    this.camera.instance.updateProjectionMatrix();
    this.camera.controls.target.set(0, 48, -140);
    this.camera.controls.maxPolarAngle = Math.PI * 0.49;
    this.camera.controls.maxDistance = 400;
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

    // Physical-to-world scale of the player: 1 on desktop, GIANT_SCALE in
    // the headset (the camera rig is scaled up and stood on the flank).
    // Interaction thresholds and particle physics read this every frame.
    this.worldScale = 1;
  }

  async init({ device, sim }) {
    this.device = device;
    this.sim = sim;

    // Known before the renderer exists so it can pick per-platform options
    // (no MSAA where an XR session may attach).
    this.xrSupported =
      "xr" in navigator &&
      (await navigator.xr.isSessionSupported("immersive-vr").catch(() => false));

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

    // Compile the XR-target pipeline variants now, not mid-session.
    if (this.xrSupported) {
      this.renderer.manualXR.warmup(this.scene, this.camera.instance);
    }

    this.hands = new Hands();
    this.mouseCarve = new MouseCarve();

    // --- the giant: scale and place the rig when an XR session starts ---
    // The rig stands partway up the flank; at 60x, the carve field uphill
    // sits a physical arm's reach below the hands and the summit crest
    // looms a few physical metres ahead.
    const xr = this.renderer.instance.xr;
    xr.addEventListener("sessionstart", () => {
      this.worldScale = GIANT_SCALE;
      this.cameraGroup.position.set(
        RIG_XZ.x,
        terrainSurfaceY(RIG_XZ.x, RIG_XZ.z),
        RIG_XZ.z
      );
      this.cameraGroup.scale.setScalar(GIANT_SCALE);
      // near/far in world units: 2 m world is ~3 physical centimetres
      this.camera.instance.near = 2;
      this.camera.instance.far = 20000;
      this.camera.instance.updateProjectionMatrix();
    });
    xr.addEventListener("sessionend", () => {
      this.worldScale = 1;
      this.cameraGroup.position.set(0, 0, 0);
      this.cameraGroup.scale.setScalar(1);
      this.camera.instance.near = 0.1;
      this.camera.instance.far = 5000;
      this.camera.instance.updateProjectionMatrix();
    });

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
