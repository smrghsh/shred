import {
  Fn,
  acos,
  atan,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  ivec2,
  length,
  max,
  mix,
  normalize,
  pow,
  sign,
  smoothstep,
  texture,
  textureLoad,
  vec2,
  vec3,
} from "three/tsl";
import { SKY } from "./SkyLut.js";

// TSL twin of the WGSL shading library: every snow surface (the carvable
// field, the dunes) is lit by the same sunRadiance + SH ambient the sky dome
// and its far range use, and hazed by the same aerial perspective converging
// on the same LUT — one atmosphere, one light, no matte-painting seams.

const INV_PI = 1 / Math.PI;

export default function createSnowLighting(skyLut) {
  const shTex = skyLut.shTex;
  const lutTex = skyLut.texture;

  const shL = (i) => textureLoad(shTex, ivec2(i, 0)).rgb;

  // Ramamoorthi-Hanrahan irradiance from the 9 baked radiance coefficients.
  const shIrradiance = Fn(([n]) => {
    return max(
      vec3(0),
      shL(0)
        .mul(0.886227)
        .add(shL(1).mul(n.y).add(shL(2).mul(n.z)).add(shL(3).mul(n.x)).mul(1.023328))
        .add(
          shL(4)
            .mul(n.x.mul(n.y))
            .add(shL(5).mul(n.y.mul(n.z)))
            .add(shL(7).mul(n.x.mul(n.z)))
            .mul(0.858086)
        )
        .add(shL(6).mul(n.z.mul(n.z).mul(3).sub(1)).mul(0.247708))
        .add(shL(8).mul(n.x.mul(n.x).sub(n.y.mul(n.y))).mul(0.429043))
    );
  });

  const wrapDiffuse = (ndl, w) => clamp(ndl.add(w).div(1 + w), 0, 1);

  // Wrapped sun + SH sky ambient + a Fresnel sky reflection read straight
  // from the LUT at the mirrored view direction. The reflection term is what
  // keeps flat snow cool at grazing view angles — without it a low warm sun
  // owns every up-facing surface and the whole field goes beige.
  const shadeSnow = Fn(([albedo, nrm, worldPos]) => {
    const L = vec3(skyLut.uSunDir);
    const direct = albedo
      .mul(INV_PI)
      .mul(vec3(skyLut.uSunRadiance))
      .mul(wrapDiffuse(dot(nrm, L), 0.62));
    const ambient = albedo.mul(INV_PI).mul(shIrradiance(nrm)).mul(skyLut.uAmbient);

    const viewDir = normalize(worldPos.sub(cameraPosition));
    const ndv = clamp(dot(nrm, viewDir.negate()), 0, 1);
    // capped low: snow is matte — this is a sheen, not a mirror, and at full
    // grazing strength the whole mid-distance reads as a dead frozen lake
    const fresnel = float(0.04).add(ndv.oneMinus().pow(5).mul(0.22));
    const reflDir = normalize(viewDir.sub(nrm.mul(dot(nrm, viewDir).mul(2))));
    const reflUp = vec3(reflDir.x, reflDir.y.abs(), reflDir.z); // snow reflects sky, not ground
    const skyRefl = texture(lutTex, dirToLatLong(reflUp), float(2)).rgb;

    // subsurface: snow is translucent, and slopes with the sun behind them
    // glow instead of going to dark silhouette — without this, backlit dunes
    // read as dirt (snowflow's own hard-won lesson on its far range)
    const vl = clamp(dot(viewDir, L), 0, 1);
    const sss = vec3(skyLut.uSunRadiance)
      .mul(albedo)
      .mul(vl.pow(6).mul(dot(nrm, L).clamp(0, 1).oneMinus()).mul(0.055));

    return direct.add(ambient).add(skyRefl.mul(fresnel).mul(skyLut.uAmbient)).add(sss);
  });

  const dirToLatLong = Fn(([d]) => {
    const u = atan(d.x, d.z)
      .div(2 * Math.PI)
      .add(0.5);
    const v = acos(clamp(d.y, -1, 1)).div(Math.PI);
    return vec2(u, v);
  });

  const phaseMie062 = (mu) => {
    // g = 0.62, snowflow's short-path forward lobe
    const g = 0.62;
    const g2 = g * g;
    const n = float((1 - g2) * (3 / (8 * Math.PI))).mul(mu.mul(mu).add(1));
    const d = pow(float(1 + g2).sub(mu.mul(2 * g)), 1.5).mul(2 + g2);
    return n.div(d);
  };

  // Height-falloff extinction + inscatter that converges on the exact sky
  // sample — a hazed dune and the sky pixel beside it end as the same number.
  const applyAerial = Fn(([col, worldPos]) => {
    const cam = cameraPosition;
    const dvec = worldPos.sub(cam);
    const len = max(length(dvec), 1e-4);
    const viewDir = dvec.div(len);
    const dist = max(len.sub(SKY.fogStart), 0);

    const k = float(SKY.fogHeightFalloff);
    // guard the closed form against horizontal rays
    const dy = dvec.y;
    const dySafe = sign(dy.add(1e-5)).mul(max(dy.abs(), 0.01));
    const integral = exp(k.negate().mul(cam.y))
      .sub(exp(k.negate().mul(worldPos.y)))
      .div(k.mul(dySafe))
      .mul(dist);
    const t = exp(float(-SKY.fogDensity).mul(max(integral, 0)));
    const ext = clamp(float(1).sub(pow(t, SKY.aerialStrength)), 0, 1);

    const exact = texture(lutTex, dirToLatLong(viewDir), float(0)).rgb;
    const tilted = normalize(viewDir.add(vec3(0, 0.42, 0)));
    const mu = dot(viewDir, vec3(skyLut.uSunDir));
    const near = texture(lutTex, dirToLatLong(tilted), float(3))
      .rgb.add(vec3(skyLut.uSunColor).mul(phaseMie062(mu).mul(5.5 * 0.16)));
    const inscatter = mix(near, exact, smoothstep(0.55, 0.995, ext));

    return mix(col, inscatter, ext);
  });

  return { shIrradiance, wrapDiffuse, shadeSnow, applyAerial };
}
