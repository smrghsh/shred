import * as THREE from "three";
import Experience from "../Experience/Experience.js";

// Left-fist grab-and-pull locomotion — the seals Locomotion.js squeeze
// pattern, hand-tracked: make a fist with the left hand to grab the world,
// pull to glide the rig the opposite way, open to let go. The gesture is
// measured in rig-local (reference-space, physical) coordinates, so the
// rig's own motion never feeds back into the pull.

const GRAB_CURL = 0.09; // avg fingertip->wrist distance below this = fist (physical m)
const RELEASE_CURL = 0.12; // hysteresis
const SPEED = 3; // seals uses 4; the giant covers ground fast enough at 3
const TIPS = [
  "index-finger-tip",
  "middle-finger-tip",
  "ring-finger-tip",
  "pinky-finger-tip",
];

export default class GrabLocomotion {
  constructor() {
    this.experience = new Experience();
    this.hands = this.experience.hands.hands; // three's XR hand groups
    for (const hand of this.hands) {
      hand.addEventListener("connected", (e) => {
        hand.userData.handedness = e.data?.handedness ?? null;
      });
      hand.addEventListener("disconnected", () => {
        hand.userData.handedness = null;
      });
    }
    this.grabbing = false;
    this.anchor = new THREE.Vector3();
    this._delta = new THREE.Vector3();
  }

  _leftHand() {
    return this.hands.find((h) => h.userData.handedness === "left");
  }

  // Average fingertip-to-wrist distance; null when joints are missing.
  _curl(hand) {
    const wrist = hand.joints?.["wrist"];
    if (!wrist) return null;
    let sum = 0;
    let n = 0;
    for (const name of TIPS) {
      const j = hand.joints[name];
      if (j && j.visible !== false) {
        sum += j.position.distanceTo(wrist.position);
        n++;
      }
    }
    return n === TIPS.length ? sum / n : null;
  }

  update() {
    if (!this.experience.isXRActive()) {
      this.grabbing = false;
      return;
    }
    const hand = this._leftHand();
    const curl = hand ? this._curl(hand) : null;
    if (curl === null) {
      this.grabbing = false;
      return;
    }

    const wrist = hand.joints["wrist"];
    if (!this.grabbing && curl < GRAB_CURL) {
      this.grabbing = true;
      this.anchor.copy(wrist.position);
    } else if (this.grabbing && curl > RELEASE_CURL) {
      this.grabbing = false;
    }

    if (this.grabbing) {
      const rig = this.experience.cameraGroup;
      this._delta
        .copy(wrist.position)
        .sub(this.anchor) // physical, rig-local
        .multiplyScalar(rig.scale.x * SPEED); // into world units
      rig.position.sub(this._delta);
      this.anchor.copy(wrist.position);
    }
  }
}
