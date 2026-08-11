import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import Experience from "../Experience/Experience.js";
import carveBrushes from "./carveBrushes.js";
import { FIELD_CENTER, FIELD_LIFT } from "../Experience/World/constants.js";
import { FIELD_SIZE } from "../snow/SnowSim.js";
import { terrainSurfaceY } from "../terrain/terrainSurface.js";

// WebXR hand tracking (visionOS Safari exposes full joints with the
// "hand-tracking" session feature). The tech-deck grip: touch your RIGHT
// index and middle fingertips together and the snowboard pops in spanning
// the gap — nose under the index, tail under the middle finger, exactly
// how a fingerboard rides two fingers (the left hand belongs to
// grab-locomotion). Sweep it through the mountainside to carve; the brush
// lean follows your turn and throws the berm to the outside. Spread the
// two fingers into a V and the board vanishes.
//
// Adjacent-finger tips idle a few centimetres apart, so summon means
// actually touching them and dismiss means a deliberate spread.
//
// The hands are children of the (scaled) camera rig, so joint world
// positions arrive pre-scaled to giant size; physical thresholds multiply
// by the rig scale.

const SUMMON_GAP = 0.045; // index-to-middle tip gap that summons, physical meters
const RELEASE_GAP = 0.11; // spread the fingers to dismiss
const LOST_TIMEOUT = 0.5; // seconds without joints before dismissing
const DECK_PHYSICAL = 0.096; // a real tech deck: 96 mm, fixed
const DECK_DROP = 0.012; // deck sits this far below the finger pads, physical

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
      hand.addEventListener("connected", (e) => {
        hand.userData.handedness = e.data?.handedness ?? null;
      });
      hand.addEventListener("disconnected", () => {
        hand.userData.handedness = null;
      });
      this.cameraGroup.add(hand);
      return hand;
    });

    this.lastMid = new THREE.Vector3();
    this.mid = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._tip2 = new THREE.Vector3();
    this._knuckleA = new THREE.Vector3();
    this._knuckleB = new THREE.Vector3();
    this._fingerDir = new THREE.Vector3();
    this._deckUp = new THREE.Vector3();
    this._deckX = new THREE.Vector3();
    this._deckZ = new THREE.Vector3();
    this._deckMat = new THREE.Matrix4();
    this._deckQuat = new THREE.Quaternion();
    this._deckPos = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this.lostTime = 0;
    this.holding = false;
    this.yaw = 0;
    this.carve = 0;

    this._sprayVel = new THREE.Vector3();
  }

  _rightHand() {
    return this.hands.find((h) => h.userData.handedness === "right");
  }

  // Deck pose from the right hand's finger geometry; writes _deckPos and
  // (smoothed) _deckQuat. Assumes _tip/_tip2/mid are fresh.
  _deckPose(hand, dt) {
    const s = this.experience.worldScale;
    const ka = hand.joints?.["index-finger-phalanx-proximal"];
    const kb = hand.joints?.["middle-finger-phalanx-proximal"];

    if (ka && kb) {
      ka.getWorldPosition(this._knuckleA);
      kb.getWorldPosition(this._knuckleB);

      // fingers' pointing direction: knuckles -> tips, both fingers averaged
      this._fingerDir
        .copy(this._tip)
        .sub(this._knuckleA)
        .add(this._v.copy(this._tip2).sub(this._knuckleB))
        .normalize();
      this._deckUp.copy(this._fingerDir).negate();

      // long axis: knuckle line projected into the deck plane
      this._deckX.copy(this._knuckleB).sub(this._knuckleA);
      this._deckX.addScaledVector(this._deckUp, -this._deckX.dot(this._deckUp));
      if (this._deckX.lengthSq() > 1e-8) {
        this._deckX.normalize();
        this._deckZ.crossVectors(this._deckX, this._deckUp).normalize();
        this._deckMat.makeBasis(this._deckX, this._deckUp, this._deckZ);
        const target = this._quatTmp ?? (this._quatTmp = new THREE.Quaternion());
        target.setFromRotationMatrix(this._deckMat);
        this._deckQuat.slerp(target, Math.min(1, dt * 20));
      }
    }

    this._deckPos
      .copy(this.mid)
      .addScaledVector(this._deckUp, -DECK_DROP * s);
  }

  // Grip midpoint (world) of the right hand's index and middle fingertips,
  // or null when joints are gone.
  _pinchPoint(hand) {
    const tip = hand.joints?.["index-finger-tip"];
    const tip2 = hand.joints?.["middle-finger-tip"];
    if (!tip || !tip2 || hand.visible === false) return null;
    tip.getWorldPosition(this._tip);
    tip2.getWorldPosition(this._tip2);
    return this.mid.copy(this._tip).add(this._tip2).multiplyScalar(0.5);
  }

  update(dt) {
    if (!this.experience.isXRActive()) return;
    const board = this.experience.world.snowboard;
    const s = this.experience.worldScale; // physical -> world

    const hand = this._rightHand();
    const mid = hand ? this._pinchPoint(hand) : null;
    const gap = mid ? this._tip.distanceTo(this._tip2) : Infinity;

    // once-a-second gesture diagnostics into the remote log
    this._diagT = (this._diagT ?? 0) + dt;
    if (this._diagT > 1) {
      this._diagT = 0;
      window.shredLog?.(
        `[hands] right:${hand ? "ok" : "-"} joints:${mid ? "ok" : "-"}` +
          ` gap:${gap === Infinity ? "-" : (gap / s).toFixed(3)} holding:${this.holding}`
      );
    }

    if (mid === null) {
      this.lostTime += dt;
      if (this.holding && this.lostTime > LOST_TIMEOUT) {
        this.holding = false;
        board.hide();
      }
      return;
    }
    this.lostTime = 0;

    if (!this.holding && gap < SUMMON_GAP * s) {
      this.holding = true;
      board.show();
      this.lastMid.copy(mid);
      this.carve = 0;
      // a little poof of powder to celebrate the summon
      this.experience.world.spray.emit(mid, this._sprayVel.set(0, 0.3 * s, 0), 20);
    } else if (this.holding && gap > RELEASE_GAP * s) {
      this.holding = false;
      board.hide();
    }

    if (!this.holding) return;

    // --- carving contact against the mountainside ---
    const surface = terrainSurfaceY(mid.x, mid.z) + FIELD_LIFT;
    const pen = surface + 0.01 * s - (mid.y - 0.012 * s);
    const dx = mid.x - this.lastMid.x;
    const dz = mid.z - this.lastMid.z;
    const moved = Math.hypot(dx, dz);
    const fx = mid.x - FIELD_CENTER.x;
    const fz = mid.z - FIELD_CENTER.z;
    const inField = Math.abs(fx) < FIELD_SIZE / 2 && Math.abs(fz) < FIELD_SIZE / 2;

    // the tech deck: fixed 96 mm (physical) deck riding flat under the two
    // fingertips — the fingers are the rider's legs. Up is opposite the
    // fingers' pointing direction; the long axis follows the stable
    // knuckle-to-knuckle line (tips converge when touching, knuckles
    // don't), projected into the deck plane; orientation is smoothed so
    // joint noise never makes the deck spazz.
    this._deckPose(hand, dt);
    board.setPoseTechDeck(
      this._deckPos,
      this._deckQuat,
      (DECK_PHYSICAL * s) / 0.3 // BOARD_LENGTH
    );

    // brush yaw follows the sweep; the turn rate becomes the carve lean
    // (the proven feel from the desktop path)
    if (moved > 0.002 * s) {
      const targetYaw = Math.atan2(-dz, dx);
      let dYaw = targetYaw - this.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      this.yaw += dYaw * Math.min(1, dt * 14);
      this.carve = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(this.carve, dYaw * 6, Math.min(1, dt * 8)),
        -1,
        1
      );
    }

    if (pen > 0 && pen < 6 && moved > 0.0005 && inField) {
      this.experience.brushQueue.push(
        ...carveBrushes({ x: fx, z: fz, yaw: this.yaw, moved, pen, carve: this.carve })
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
