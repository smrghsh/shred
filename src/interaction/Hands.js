import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import Experience from "../Experience/Experience.js";
import carveBrushes from "./carveBrushes.js";
import { FIELD_CENTER, FIELD_LIFT } from "../Experience/World/constants.js";
import { FIELD_SIZE } from "../snow/SnowSim.js";
import { terrainSurfaceY } from "../terrain/terrainSurface.js";

// WebXR hand tracking (visionOS Safari exposes full joints with the
// "hand-tracking" session feature). The gesture: bring the index fingertips
// of both hands within 3 inches of each other and the snowboard pops in
// spanning the gap — nose at one fingertip, tail at the other. Sweep it
// through the mountainside to carve; tilt your hands to lean the board and
// throw the berm to the outside of the turn. Spread your hands apart and
// the board vanishes.
//
// The hands are children of the (scaled) camera rig, so joint world
// positions arrive pre-scaled to giant size; the summon/release thresholds
// are PHYSICAL distances and multiply by the rig scale.

const SUMMON_DIST = 0.0762; // 3 inches, physical
const RELEASE_DIST = 0.55; // generous hysteresis — the board stretches first
const LOST_TIMEOUT = 0.5; // seconds without joints before dismissing

export default class Hands {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.cameraGroup = this.experience.cameraGroup;
    this.renderer = this.experience.renderer.instance;

    const factory = new XRHandModelFactory();
    this.hands = [0, 1].map((i) => {
      const hand = this.renderer.xr.getHand(i);
      hand.add(factory.createHandModel(hand, "spheres"));
      this.cameraGroup.add(hand);
      return hand;
    });

    this.tips = [new THREE.Vector3(), new THREE.Vector3()];
    this.lastMid = new THREE.Vector3();
    this.mid = new THREE.Vector3();
    this.lostTime = 0;
    this.holding = false;

    this._sprayVel = new THREE.Vector3();
  }

  _tipPositions() {
    let found = 0;
    for (let i = 0; i < 2; i++) {
      const joint = this.hands[i].joints?.["index-finger-tip"];
      if (joint && this.hands[i].visible !== false) {
        joint.getWorldPosition(this.tips[i]);
        found++;
      }
    }
    return found === 2;
  }

  update(dt) {
    if (!this.experience.isXRActive()) return;
    const board = this.experience.world.snowboard;
    const s = this.experience.worldScale; // physical -> world

    if (!this._tipPositions()) {
      this.lostTime += dt;
      if (this.holding && this.lostTime > LOST_TIMEOUT) {
        this.holding = false;
        board.hide();
      }
      return;
    }
    this.lostTime = 0;

    const dist = this.tips[0].distanceTo(this.tips[1]);

    if (!this.holding && dist < SUMMON_DIST * s) {
      this.holding = true;
      board.show();
      this.mid.copy(this.tips[0]).add(this.tips[1]).multiplyScalar(0.5);
      this.lastMid.copy(this.mid);
      // a little poof of powder to celebrate the summon
      this.experience.world.spray.emit(this.mid, this._sprayVel.set(0, 0.3 * s, 0), 20);
    } else if (this.holding && dist > RELEASE_DIST * s) {
      this.holding = false;
      board.hide();
    }

    if (!this.holding) return;

    board.setPoseFromTips(this.tips[0], this.tips[1]);
    this.mid.copy(this.tips[0]).add(this.tips[1]).multiplyScalar(0.5);

    // --- carving contact against the mountainside ---
    const surface = terrainSurfaceY(this.mid.x, this.mid.z) + FIELD_LIFT;
    const pen = surface + 0.01 * s - (this.mid.y - 0.012 * s);
    const dx = this.mid.x - this.lastMid.x;
    const dz = this.mid.z - this.lastMid.z;
    const moved = Math.hypot(dx, dz);
    const fx = this.mid.x - FIELD_CENTER.x;
    const fz = this.mid.z - FIELD_CENTER.z;
    const inField = Math.abs(fx) < FIELD_SIZE / 2 && Math.abs(fz) < FIELD_SIZE / 2;

    if (pen > 0 && pen < 6 && moved > 0.0005 && inField) {
      // carve direction from board lean: how far board-up tips toward the
      // side of the direction of travel
      const yaw = Math.atan2(-dz, dx);
      const boardUp = new THREE.Vector3(0, 1, 0).applyQuaternion(board.group.quaternion);
      const perp = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const carve = THREE.MathUtils.clamp(boardUp.dot(perp) * 2.5, -1, 1);

      this.experience.brushQueue.push(
        ...carveBrushes({ x: fx, z: fz, yaw, moved, pen, carve })
      );

      // spray flies opposite the direction of travel, harder when moving
      // fast (thresholds and velocities scale with the rig so the powder
      // reads the same at the giant's eye)
      const speed = moved / Math.max(dt, 1e-3);
      if (speed > 0.25 * s) {
        this._sprayVel.set(-dx, 0.2 * s, -dz).multiplyScalar((speed * 0.9) / s);
        this.experience.world.spray.emit(
          new THREE.Vector3(this.mid.x, surface + 0.02 * s, this.mid.z),
          this._sprayVel,
          Math.min(6, Math.floor((speed / s) * 5))
        );
      }
    }

    this.lastMid.copy(this.mid);
  }
}
