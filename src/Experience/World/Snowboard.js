import * as THREE from "three";
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from "three/webgpu";
import { mix, positionLocal, smoothstep, uv, vec3, vec4, float, length } from "three/tsl";
import Experience from "../Experience.js";
import { FIELD_LIFT } from "./constants.js";
import { terrainSurfaceY, terrainSurfaceNormal } from "../../terrain/terrainSurface.js";

// Fully procedural snowboard, fingerboard scale (~30 cm), built along local
// +X with nose/tail rocker. It lives hidden until an emitter (hand pinch or
// mouse drag) summons it; a soft blob shadow hovers on the snow beneath it
// so you can judge height before the board bites.

export const BOARD_LENGTH = 0.3;
export const BOARD_WIDTH = 0.085;
const THICKNESS = 0.009;
const FLAT_HALF = 0.09; // rocker starts outboard of this

export default class Snowboard {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    this._buildDeck();
    this._buildShadow();

    this.active = false;
    this.popT = 1; // 0..1 scale-in animation
    this._tipVec = new THREE.Vector3();
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._terrainN = new THREE.Vector3();
    this._slopeQuat = new THREE.Quaternion();
  }

  _buildDeck() {
    const L = BOARD_LENGTH / 2;
    const W = BOARD_WIDTH / 2;
    const r = W * 0.96; // nose/tail radius
    const shape = new THREE.Shape();
    shape.moveTo(-L + r, -W);
    shape.lineTo(L - r, -W);
    shape.absarc(L - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
    shape.lineTo(-L + r, W);
    shape.absarc(-L + r, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: THICKNESS,
      bevelEnabled: true,
      bevelThickness: 0.0015,
      bevelSize: 0.0015,
      bevelSegments: 1,
      curveSegments: 10,
    });
    geometry.rotateX(-Math.PI / 2); // lie flat: length x, width z, thickness y

    // nose/tail rocker
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const over = Math.abs(x) - FLAT_HALF;
      if (over > 0) pos.setY(i, pos.getY(i) + over * over * 3.2);
    }
    geometry.computeVertexNormals();

    // sunset-gradient wrap along the length
    const material = new MeshStandardNodeMaterial({
      roughness: 0.35,
      metalness: 0.05,
    });
    const t = smoothstep(float(-L), float(L), positionLocal.x);
    const teal = vec3(0.05, 0.65, 0.65);
    const violet = vec3(0.45, 0.15, 0.7);
    const magenta = vec3(0.9, 0.2, 0.45);
    material.colorNode = mix(mix(teal, violet, t.mul(2).clamp(0, 1)), magenta, t.sub(0.5).mul(2).clamp(0, 1));

    this.deck = new THREE.Mesh(geometry, material);
    this.group.add(this.deck);

    // bindings: two angled dark stubs
    const bindingGeo = new THREE.BoxGeometry(0.028, 0.012, 0.05);
    const bindingMat = new THREE.MeshStandardMaterial({ color: 0x1c1f26, roughness: 0.6 });
    for (const side of [-1, 1]) {
      const binding = new THREE.Mesh(bindingGeo, bindingMat);
      binding.position.set(side * 0.062, THICKNESS + 0.006, 0);
      binding.rotation.y = side * 0.35;
      this.group.add(binding);
    }
  }

  _buildShadow() {
    const geometry = new THREE.CircleGeometry(0.11, 24);
    geometry.rotateX(-Math.PI / 2);
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
    });
    const d = length(uv().sub(0.5)).mul(2);
    material.colorNode = vec4(vec3(0.1, 0.14, 0.24), smoothstep(0.15, 1, d).oneMinus().mul(0.4));
    this.shadow = new THREE.Mesh(geometry, material);
    this.shadow.visible = false;
    this.shadow.renderOrder = 1;
    this.scene.add(this.shadow);
  }

  // Place the board spanning tip0 -> tip1 (nose at one fingertip, tail at
  // the other). Scale is uniform from the fingertip span, so the giant's
  // 4.5 m (world) board is still 7.6 physical centimetres between fingers.
  setPoseFromTips(tip0, tip1) {
    const mid = this._tipVec.copy(tip0).add(tip1).multiplyScalar(0.5);
    this.group.position.copy(mid);
    const dir = new THREE.Vector3().subVectors(tip1, tip0);
    const span = dir.length();
    if (span > 1e-4) {
      this._quat.setFromUnitVectors(this._xAxis, dir.normalize());
      this.group.quaternion.copy(this._quat);
    }
    this._targetScale = THREE.MathUtils.clamp(span / BOARD_LENGTH, 0.7, 80);
    this._applyScale();
    this._updateShadow();
  }

  // On-the-snow pose for the desktop mouse fallback: yaw + carve lean in
  // the local terrain's tangent frame.
  setPoseFlat(x, z, yaw, lean = 0) {
    this.group.position.set(x, terrainSurfaceY(x, z) + FIELD_LIFT + 0.012, z);
    terrainSurfaceNormal(x, z, this._terrainN);
    this._slopeQuat.setFromUnitVectors(this._up, this._terrainN);
    this.group.quaternion
      .setFromEuler(new THREE.Euler(-lean * 0.35, yaw, 0))
      .premultiply(this._slopeQuat);
    // the desktop board is giant-sized too: 3.6 m over the 120 m field is
    // the same proportion the 30 cm board had over the old 6 m one
    this._targetScale = 12;
    this._applyScale();
    this._updateShadow();
  }

  _applyScale() {
    const pop = 1 - Math.pow(1 - this.popT, 3); // ease-out cubic
    this.group.scale.setScalar((this._targetScale ?? 1) * pop);
  }

  _updateShadow() {
    const s = this._targetScale ?? 1; // board scale doubles as the size unit
    const base =
      terrainSurfaceY(this.group.position.x, this.group.position.z) + FIELD_LIFT;
    const height = this.group.position.y - base;
    this.shadow.visible =
      this.group.visible && height > -0.05 * s && height < 0.6 * s;
    if (!this.shadow.visible) return;
    this.shadow.position.set(
      this.group.position.x,
      base + 0.02 * s,
      this.group.position.z
    );
    // lie in the terrain's tangent plane (a level disc would bury its
    // uphill half), yawed with the board
    terrainSurfaceNormal(this.group.position.x, this.group.position.z, this._terrainN);
    this._slopeQuat.setFromUnitVectors(this._up, this._terrainN);
    const yaw = new THREE.Euler().setFromQuaternion(this.group.quaternion, "YXZ").y;
    this.shadow.quaternion
      .setFromEuler(new THREE.Euler(0, yaw, 0))
      .premultiply(this._slopeQuat);
    const closeness = 1 - THREE.MathUtils.clamp(height / (0.6 * s), 0, 1);
    this.shadow.scale.setScalar((0.5 + closeness * 0.6) * s);
  }

  show() {
    if (this.active) return;
    this.active = true;
    this.popT = 0;
    this.group.visible = true;
  }

  hide() {
    this.active = false;
    this.group.visible = false;
    this.shadow.visible = false;
  }

  update(dt) {
    if (this.active && this.popT < 1) {
      this.popT = Math.min(1, this.popT + dt * 4.5);
      this._applyScale();
    }
  }
}
