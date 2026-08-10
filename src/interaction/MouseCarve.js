import * as THREE from "three";
import Experience from "../Experience/Experience.js";
import carveBrushes from "./carveBrushes.js";
import { SNOW_Y, SLOPE_GRADE, surfaceY } from "../Experience/World/constants.js";
import { FIELD_SIZE } from "../snow/SnowSim.js";

// Desktop fallback so the carve loop is testable without a headset: a
// left-drag that starts on the snowfield carves (the board appears and
// follows the cursor); drags that start off the field orbit as usual.
// Turning sharply while dragging leans the virtual board into the turn.

export default class MouseCarve {
  constructor() {
    this.experience = new Experience();
    this.canvas = this.experience.canvas;
    this.camera = this.experience.camera;
    this.sizes = this.experience.sizes;

    this.raycaster = new THREE.Raycaster();
    // the base slope is an exact plane over the carve field, so the drag
    // raycast can stay an analytic plane intersection
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 1, SLOPE_GRADE).normalize(),
      new THREE.Vector3(0, SNOW_Y, 0)
    );
    this.ndc = new THREE.Vector2();
    this.hit = new THREE.Vector3();
    this.lastHit = new THREE.Vector3();

    this.carving = false;
    this.yaw = 0;
    this.carve = 0;
    this._queued = null;

    this.canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    window.addEventListener("pointermove", (e) => this._onMove(e));
    window.addEventListener("pointerup", () => this._onUp());
  }

  _raycast(e) {
    this.ndc.set(
      (e.clientX / this.sizes.width) * 2 - 1,
      -(e.clientY / this.sizes.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndc, this.camera.instance);
    return this.raycaster.ray.intersectPlane(this.plane, this.hit) !== null;
  }

  _inField() {
    return (
      Math.abs(this.hit.x) < FIELD_SIZE / 2 && Math.abs(this.hit.z) < FIELD_SIZE / 2
    );
  }

  _onDown(e) {
    if (this.experience.isXRActive() || e.button !== 0) return;
    if (!this._raycast(e) || !this._inField()) return;
    this.carving = true;
    this.lastHit.copy(this.hit);
    this.experience.world.snowboard.show();
  }

  _onMove(e) {
    if (!this.carving) return;
    if (!this._raycast(e)) return;
    this._queued = { x: this.hit.x, z: this.hit.z };
  }

  _onUp() {
    if (!this.carving) return;
    this.carving = false;
    this.experience.world.snowboard.hide();
  }

  // brush emission happens on the frame clock, not the pointer-event clock,
  // so stroke depth doesn't depend on the OS event rate
  update(dt) {
    if (!this.carving || !this._queued) return;
    const { x, z } = this._queued;
    this._queued = null;

    const dx = x - this.lastHit.x;
    const dz = z - this.lastHit.z;
    const moved = Math.hypot(dx, dz);
    if (moved < 0.0005) return;

    const targetYaw = Math.atan2(-dz, dx);
    // shortest-arc yaw smoothing; the turn rate becomes the carve lean
    let dYaw = targetYaw - this.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.yaw += dYaw * Math.min(1, dt * 14);
    this.carve = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(this.carve, dYaw * 6, Math.min(1, dt * 8)),
      -1,
      1
    );

    const board = this.experience.world.snowboard;
    board.setPoseFlat(x, z, this.yaw, this.carve); // lean visibly into the turn

    this.experience.brushQueue.push(
      ...carveBrushes({ x, z, yaw: this.yaw, moved, pen: 0.045, carve: this.carve })
    );

    const speed = moved / Math.max(dt, 1e-3);
    if (speed > 0.4) {
      this.experience.world.spray.emit(
        new THREE.Vector3(x, surfaceY(x, z) + 0.02, z),
        new THREE.Vector3(-dx, 0.25, -dz).multiplyScalar(speed * 0.8),
        Math.min(6, Math.floor(speed * 4))
      );
    }

    this.lastHit.set(x, surfaceY(x, z), z);
  }
}
