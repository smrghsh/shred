import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { cameraPosition, normalize, positionLocal, texture, uniform, wgsl, wgslFn } from "three/tsl";
import Experience from "../Experience/Experience.js";
import { SKY } from "./SkyLut.js";
import noiseLibCode from "./shaders/noiseLib.wgsl?raw";
import atmosphereLibCode from "./shaders/atmosphereLib.wgsl?raw";
import ridgeLibCode from "./shaders/ridgeLib.wgsl?raw";
import shadingLibCode from "./shaders/shadingLib.wgsl?raw";

// The sky itself: the baked scattering LUT, a raymarched far mountain range
// lit with the field's own snow shading, the solar disc with limb darkening,
// the aureole, and thin wind-aligned cirrus — snowflow_demo's sky.fragment
// ported to a three sky dome via wgslFn. The range sits 5.5-45 km out and is
// confined to a narrow band around the horizon, so the march touches a few
// per cent of the frame.

const DOME_RADIUS = 900;

export default class SkyDome {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.skyLut = this.experience.skyLut;

    this.uTime = uniform(0);
    const windRad = (SKY.windDirection * Math.PI) / 180;
    this.uWindDir = uniform(new THREE.Vector2(Math.sin(windRad), Math.cos(windRad)));

    const skyFn = wgslFn(
      `fn shredSky(
        dirIn: vec3<f32>,
        camPos: vec3<f32>,
        lut: texture_2d<f32>,
        lutSamp: sampler,
        shTex: texture_2d<f32>,
        sunDir: vec3<f32>,
        sunColor: vec3<f32>,
        sunI: f32,
        sunRadiance: vec3<f32>,
        ambientI: f32,
        ridgeAmp: f32,
        time: f32,
        windDir: vec2<f32>,
        cloudAmount: f32,
        fogDensity: f32,
        fogHeightFalloff: f32,
        fogStart: f32,
        aerialStrength: f32
      ) -> vec4<f32> {
        let dir = normalize(dirIn);
        var col = textureSampleLevel(lut, lutSamp, dirToLatLong(dir), 0.0).rgb;

        // ------------------------------------------------- far-field range
        // The lower bound reaches below the horizon on purpose: the terrain
        // drawn after the sky occludes the range's feet, which is what stops
        // it standing on a ruler-straight line.
        if (ridgeAmp > 1.0 && dir.y < 0.230 && dir.y > -0.050) {
          let hit = ridgeMarch(camPos, dir, ridgeAmp);
          if (hit.hit) {
            col = shadeRidgeP(
              hit, dir, camPos, sunDir, sunColor, sunRadiance,
              shTex, ambientI, ridgeAmp, lut, lutSamp,
              fogDensity, fogHeightFalloff, fogStart, aerialStrength
            );
          }
        }

        // ---------------------------------------------------- solar disc
        // ~0.53 degrees across, with limb darkening; the aureole around it is
        // forward-scattered light, a large part of why the horizon reads warm.
        let mu = dot(dir, sunDir);
        let discCos = cos(0.0046);
        if (mu > discCos) {
          let r = sqrt(max(0.0, 1.0 - mu * mu)) / 0.0046;
          let limb = pow(max(0.0, 1.0 - r * r * 0.72), 0.42);
          col += sunColor * sunI * 42.0 * limb;
        }
        let aureole = pow(max(0.0, mu), 1400.0) * 5.5 + pow(max(0.0, mu), 64.0) * 0.28;
        col += sunColor * sunI * aureole * 0.5;

        // ------------------------------------------------------- cirrus
        // Thin, high, wind-aligned; restrained — they stop the upper sky from
        // being a flat wash, they are not subject matter.
        if (cloudAmount > 0.001 && dir.y > 0.0) {
          let planeY = 1.0 / max(0.06, dir.y);
          var cp = dir.xz * planeY * 0.5 + windDir * time * 0.004;
          let a = atan2(windDir.x, windDir.y);
          cp = rot2(a) * cp;
          cp.x *= 0.28;

          let n = fbmd(cp, 4, 2.13, 0.52).x;
          var cloud = smoothstep(0.06, 0.34, n);
          cloud *= smoothstep(0.0, 0.22, dir.y) * (1.0 - smoothstep(0.55, 1.0, dir.y) * 0.45);
          cloud *= cloudAmount;

          let sunLit = pow(max(0.0, mu * 0.5 + 0.5), 3.0);
          let cloudCol = mix(vec3f(0.52, 0.60, 0.74), sunColor * 1.35, sunLit * 0.75);
          col = mix(col, cloudCol * (0.55 + sunI * 0.06), cloud * 0.62);
        }

        return vec4f(col, 1.0);
      }`,
      [wgsl(noiseLibCode), wgsl(atmosphereLibCode), wgsl(ridgeLibCode), wgsl(shadingLibCode)]
    );

    const lutTex = texture(this.skyLut.texture);
    const material = new MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: false,
    });
    material.colorNode = skyFn({
      dirIn: normalize(positionLocal),
      camPos: cameraPosition,
      lut: lutTex,
      lutSamp: lutTex,
      shTex: texture(this.skyLut.shTex),
      sunDir: this.skyLut.uSunDir,
      sunColor: this.skyLut.uSunColor,
      sunI: this.skyLut.uSunScale,
      sunRadiance: this.skyLut.uSunRadiance,
      ambientI: this.skyLut.uAmbient,
      ridgeAmp: uniform(SKY.ridgeAmp),
      time: this.uTime,
      windDir: this.uWindDir,
      cloudAmount: uniform(SKY.cloudAmount),
      fogDensity: uniform(SKY.fogDensity),
      fogHeightFalloff: uniform(SKY.fogHeightFalloff),
      fogStart: uniform(SKY.fogStart),
      aerialStrength: uniform(SKY.aerialStrength),
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), material);
    this.mesh.renderOrder = -10; // drawn first; terrain overdraws it (no depth write)
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  update(dt) {
    this.uTime.value += dt;
  }
}
