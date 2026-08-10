import * as THREE from "three";
import { QuadMesh, MeshBasicNodeMaterial } from "three/webgpu";
import { uniform, uv, wgsl, wgslFn } from "three/tsl";
import noiseLibCode from "./shaders/noiseLib.wgsl?raw";
import atmosphereLibCode from "./shaders/atmosphereLib.wgsl?raw";

// Procedural sky, image-based lighting, and the sun's own colour — the
// snowflow_demo Sky class ported to three/WebGPU. No HDRI: the whole look
// rests on a sun 5-15 degrees up, and with an analytic model the elevation
// drags the horizon warmth, the zenith gradient and the ambient tint along
// with it, consistently.
//
// The scattering integral is far too heavy for per-pixel work, so it bakes
// into an equirectangular LUT once at load. Everything downstream — sky dome,
// ambient SH, aerial inscatter — reads that one texture. The sky and the
// snow bounce are mutually dependent (snow returns ~85% of what lands on it),
// so solve() iterates bake -> SH -> ground bounce three times.

export const SKY = {
  sunAzimuth: 196, // degrees — roughly ahead of the spawn view
  sunElevation: 13.0,
  sunIntensity: 4.2,
  sunTempWarm: 1.0,
  ambientIntensity: 1.15,
  cloudAmount: 0.55,
  windDirection: 42, // degrees; sastrugi and cirrus both run with this
  ridgeAmp: 2150, // metres — peak height of the far range
  // lighter than snowflow's 0.0072: the mountainside rises ~400 m within
  // the fog's thick band, and at the original density the whole flank
  // washed to milk — this keeps the crest and slope shading legible while
  // still drowning the downhill valley
  fogDensity: 0.005,
  fogHeightFalloff: 0.045,
  fogStart: 24,
  aerialStrength: 1.0,
};

const SUN_SCALE_BASE = 5.5;
const SNOW_ALBEDO = [0.83, 0.86, 0.91];

const LUT_W = 512;
const LUT_H = 256;
const SH_W = 64;
const SH_H = 32;

export default class SkyLut {
  constructor(renderer) {
    this.renderer = renderer;

    this.sunDir = new THREE.Vector3(0, 0.2, 1);
    this.sunColor = new THREE.Vector3(1, 0.85, 0.66);
    this.sunRadiance = new THREE.Vector3(1, 1, 1);
    this.sunScale = 1;
    this.groundBounce = new THREE.Vector3(0, 0, 0);
    this.sh = new Float32Array(36);
    this._syncSun();

    // --- uniforms shared by every material that reads this sky ---
    this.uSunDir = uniform(this.sunDir);
    this.uSunColor = uniform(this.sunColor);
    this.uSunRadiance = uniform(this.sunRadiance);
    this.uSunScale = uniform(this.sunScale);
    this.uAmbient = uniform(SKY.ambientIntensity);

    // 9 SH radiance coefficients as a 9x1 float texture (UBO arrays are
    // awkward through wgslFn; a texture is not).
    this.shTex = new THREE.DataTexture(
      new Float32Array(9 * 4),
      9,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.shTex.magFilter = THREE.NearestFilter;
    this.shTex.minFilter = THREE.NearestFilter;
    this.shTex.needsUpdate = true;

    // --- render targets ---
    this.lutRT = new THREE.RenderTarget(LUT_W, LUT_H, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: true, // the aerial near-sky reads a blurred mip
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.lutRT.texture.name = "skyLUT";
    this.shRT = new THREE.RenderTarget(SH_W, SH_H, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    // --- bake pass ---
    this._uBounce = uniform(this.groundBounce);
    const libs = [wgsl(noiseLibCode), wgsl(atmosphereLibCode)];
    const bakeFn = wgslFn(
      `fn bakeSky(uvc: vec2<f32>, sunDir: vec3<f32>, sunI: f32, bounce: vec3<f32>) -> vec4<f32> {
        let dir = latLongToDir(uvc);
        return vec4f(nishitaSky(dir, sunDir, sunI, bounce), 1.0);
      }`,
      libs
    );
    this._bakeMaterial = new MeshBasicNodeMaterial();
    this._bakeMaterial.colorNode = bakeFn({
      uvc: uv(),
      sunDir: this.uSunDir,
      sunI: this.uSunScale,
      bounce: this._uBounce,
    });
    this._quad = new QuadMesh(this._bakeMaterial);
  }

  get texture() {
    return this.lutRT.texture;
  }

  /// Sun vector + colour from the settings — direct sunlight reddens as it
  /// grazes (Kasten-Young air mass, Rayleigh+Mie vertical optical depth).
  _syncSun() {
    const az = (SKY.sunAzimuth * Math.PI) / 180;
    const el = (SKY.sunElevation * Math.PI) / 180;
    const ce = Math.cos(el);
    this.sunDir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);

    this.sunScale = SKY.sunIntensity * SUN_SCALE_BASE;

    const zenithDeg = (Math.acos(THREE.MathUtils.clamp(this.sunDir.y, -1, 1)) * 180) / Math.PI;
    const denom =
      Math.cos((zenithDeg * Math.PI) / 180) +
      0.50572 * Math.pow(Math.max(1e-3, 96.07995 - zenithDeg), -1.6364);
    const airMass = Math.min(denom > 0 ? 1 / denom : 40, 40);

    const warm = SKY.sunTempWarm;
    const tauR = [0.0464, 0.108, 0.265];
    const tauM = 0.0252;
    const r = Math.exp(-(tauR[0] * warm + tauM) * airMass);
    const g = Math.exp(-(tauR[1] * warm + tauM) * airMass);
    const b = Math.exp(-(tauR[2] * warm + tauM) * airMass);

    this.sunRadiance.set(r * this.sunScale, g * this.sunScale, b * this.sunScale);
    const m = Math.max(r, g, b) || 1;
    this.sunColor.set(r / m, g / m, b / m);
  }

  /// Bake the LUTs, project to SH, iterate the snow ground bounce until the
  /// sky and the field agree about how bright each other are.
  async solve() {
    this._syncSun();
    if (this.uSunScale) this.uSunScale.value = this.sunScale;

    this.groundBounce.set(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      this._bake();
      await this._projectSH();
      this._updateGroundBounce();
    }
    this._bake();
    await this._projectSH();

    // Orientation sanity check: sky irradiance from above must be strongly
    // blue-dominant. If this logs warm, the SH rows are flipped.
    const up = this._irradianceUp();
    console.log(
      `SkyLut solved: E_up=(${up.map((v) => v.toFixed(2)).join(", ")}) ` +
        `bounce=(${this.groundBounce.x.toFixed(2)}, ${this.groundBounce.y.toFixed(2)}, ${this.groundBounce.z.toFixed(2)})`
    );
  }

  _bake() {
    const prev = this.renderer.getRenderTarget();
    for (const rt of [this.lutRT, this.shRT]) {
      this.renderer.setRenderTarget(rt);
      this._quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(prev);
  }

  /// Radiance leaving the snow, from everything currently landing on it.
  _updateGroundBounce() {
    const up = this._irradianceUp();
    const c = Math.max(0, this.sunDir.y);
    const k = 1 / Math.PI;
    this.groundBounce.set(
      SNOW_ALBEDO[0] * (this.sunRadiance.x * c + up[0]) * k,
      SNOW_ALBEDO[1] * (this.sunRadiance.y * c + up[1]) * k,
      SNOW_ALBEDO[2] * (this.sunRadiance.z * c + up[2]) * k
    );
  }

  _irradianceUp() {
    const sh = this.sh;
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      out[k] =
        sh[0 * 4 + k] * 0.886227 +
        sh[1 * 4 + k] * 2 * 0.511664 +
        sh[6 * 4 + k] * -0.247708 +
        sh[8 * 4 + k] * -0.429043;
    }
    return out;
  }

  /// Project the small bake into 9 SH coefficients on the CPU — a one-off
  /// reduction over 2048 texels that needs to land in uniforms anyway.
  async _projectSH() {
    const px = await this.renderer.readRenderTargetPixelsAsync(this.shRT, 0, 0, SH_W, SH_H);
    if (!px) return;

    const sh = this.sh;
    sh.fill(0);
    const Y = new Float32Array(9);
    const dOmega = ((2 * Math.PI) / SH_W) * (Math.PI / SH_H);

    for (let y = 0; y < SH_H; y++) {
      // Readback rows match the bake's uv space: row 0 is the zenith.
      // (Probed live: row 0 reads dim blue sky, the last rows read the
      // constant ground bounce — and E_up below must log blue-dominant.)
      const theta = ((y + 0.5) / SH_H) * Math.PI;
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      const w = st * dOmega;

      for (let x = 0; x < SH_W; x++) {
        const phi = ((x + 0.5) / SH_W - 0.5) * 2 * Math.PI;
        const dx = st * Math.sin(phi);
        const dy = ct;
        const dz = st * Math.cos(phi);

        Y[0] = 0.282095;
        Y[1] = 0.488603 * dy;
        Y[2] = 0.488603 * dz;
        Y[3] = 0.488603 * dx;
        Y[4] = 1.092548 * dx * dy;
        Y[5] = 1.092548 * dy * dz;
        Y[6] = 0.315392 * (3 * dz * dz - 1);
        Y[7] = 1.092548 * dx * dz;
        Y[8] = 0.546274 * (dx * dx - dy * dy);

        const i = (y * SH_W + x) * 4;
        const r = px[i] * w;
        const g = px[i + 1] * w;
        const b = px[i + 2] * w;

        for (let c = 0; c < 9; c++) {
          sh[c * 4] += r * Y[c];
          sh[c * 4 + 1] += g * Y[c];
          sh[c * 4 + 2] += b * Y[c];
        }
      }
    }

    this.shTex.image.data.set(sh);
    this.shTex.needsUpdate = true;
  }
}
