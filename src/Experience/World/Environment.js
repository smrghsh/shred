import * as THREE from "three";
import Experience from "../Experience.js";

// Scene lights for the few materials that use three's built-in lighting (the
// snowboard, its bindings). Everything snow-shaped computes its own lighting
// from the SkyLut; these lights are derived from the same solve so the board
// sits in the same warm-sun / cool-sky split as the field it carves.

const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;

export default class Environment {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.skyLut = this.experience.skyLut;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.scene.add(this.sunLight);
    this.hemiLight = new THREE.HemisphereLight(0xbcd8f5, 0xe8eef5, 1.5);
    this.scene.add(this.hemiLight);

    this.applySky();
  }

  // Pull light colours/intensities from the solved sky. Safe to call again
  // if the sun ever moves.
  applySky() {
    const sky = this.skyLut;
    this.sunLight.position.copy(sky.sunDir).multiplyScalar(50);
    this.sunLight.color.setRGB(sky.sunColor.x, sky.sunColor.y, sky.sunColor.z);
    this.sunLight.intensity = lum(sky.sunRadiance);

    const up = sky._irradianceUp();
    const upMax = Math.max(up[0], up[1], up[2], 1e-3);
    this.hemiLight.color.setRGB(up[0] / upMax, up[1] / upMax, up[2] / upMax);
    const gb = sky.groundBounce;
    const gbMax = Math.max(gb.x, gb.y, gb.z, 1e-3);
    this.hemiLight.groundColor.setRGB(gb.x / gbMax, gb.y / gbMax, gb.z / gbMax);
    this.hemiLight.intensity = lum({ x: up[0], y: up[1], z: up[2] }) + lum(gb) * 0.5;
  }
}
