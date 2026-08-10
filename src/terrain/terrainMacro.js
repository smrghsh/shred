// CPU port of snowflow_demo's macro landform (lib/noise.wgsl +
// lib/terrain.wgsl): gradient noise with analytic derivatives, derivative-
// damped fBm, and the wind-anisotropic dune stack. Runs once at load to
// displace the dune mesh — nothing on the GPU ever needs to agree with it,
// so f64 drift is harmless here (unlike snowflow's character grounding,
// which is why they baked and read back instead).

const fract = (x) => x - Math.floor(x);

function hash21(x, y) {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(x * 0.1031);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
}

// Perlin-style gradient noise with quintic fade. Returns [value, ddx, ddy].
function noised(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);

  const grad = (gx, gy) => {
    const a = hash21(gx, gy) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  };
  const ga = grad(ix, iy);
  const gb = grad(ix + 1, iy);
  const gc = grad(ix, iy + 1);
  const gd = grad(ix + 1, iy + 1);

  const va = ga[0] * fx + ga[1] * fy;
  const vb = gb[0] * (fx - 1) + gb[1] * fy;
  const vc = gc[0] * fx + gc[1] * (fy - 1);
  const vd = gd[0] * (fx - 1) + gd[1] * (fy - 1);

  const k1 = vb - va;
  const k2 = vc - va;
  const k3 = va - vb - vc + vd;

  const value = va + k1 * ux + k2 * uy + k3 * ux * uy;
  const dx =
    ga[0] +
    ux * (gb[0] - ga[0]) +
    uy * (gc[0] - ga[0]) +
    ux * uy * (ga[0] - gb[0] - gc[0] + gd[0]) +
    dux * (uy * k3 + k1);
  const dy =
    ga[1] +
    ux * (gb[1] - ga[1]) +
    uy * (gc[1] - ga[1]) +
    ux * uy * (ga[1] - gb[1] - gc[1] + gd[1]) +
    duy * (ux * k3 + k2);

  return [value, dx, dy];
}

// 2x2 matrices as [c0x, c0y, c1x, c1y] (column-major, matching WGSL).
const ROT = (() => {
  const c = Math.cos(0.517);
  const s = Math.sin(0.517);
  return [c, -s, s, c];
})();

const mulMV = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
const mulVM = (x, y, m) => [x * m[0] + y * m[1], x * m[2] + y * m[3]];
const mulMM = (a, b) => {
  const c0 = mulMV(a, b[0], b[1]);
  const c1 = mulMV(a, b[2], b[3]);
  return [c0[0], c0[1], c1[0], c1[1]];
};

/// Derivative-damped fBm: each octave attenuated by the slope accumulated so
/// far, so detail collects in flat areas — the reason dunes read as
/// wind-packed drifts rather than a generic noise field. Returns [value].
function fbmDamped(x, y, octaves, lacunarity, gain, damp) {
  let px = x;
  let py = y;
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let dx = 0;
  let dy = 0;
  let xform = [1, 0, 0, 1];

  for (let i = 0; i < octaves; i++) {
    const n = noised(px * freq, py * freq);
    const w = 1 / (1 + damp * (dx * dx + dy * dy));
    sum += amp * w * n[0];
    const d = mulVM(n[1], n[2], xform);
    dx += amp * w * freq * d[0];
    dy += amp * w * freq * d[1];
    amp *= gain;
    freq *= lacunarity;
    const p = mulMV(ROT, px, py);
    px = p[0];
    py = p[1];
    xform = mulMM(ROT, xform);
  }
  return sum;
}

/// Rotate into the wind and anisotropically scale: `sx` stretches along the
/// wind, `sy` across it, `scale` is the wavelength.
function windApply(w, sx, sy, scale, x, y) {
  const c = Math.cos(w);
  const s = Math.sin(w);
  return [((c * x + s * y) * sx) / scale, ((-s * x + c * y) * sy) / scale];
}

/// Broad + medium landform, metres — snowflow's terrainMacro (sans rocks).
/// `w` is the wind bearing in radians, `amp` a global height multiplier.
export function terrainMacro(x, y, w, amp = 1) {
  // broad dunes: compressed along the wind so ridge lines run across it
  const p1 = windApply(w, 2.1, 1.0, 58.0, x, y);
  const broad = fbmDamped(p1[0], p1[1], 5, 2.03, 0.5, 0.9);
  let h = broad * 15.5;

  // a much larger, gentler swell — the horizon's long roll
  const p0 = windApply(w, 1.35, 1.0, 210.0, x, y);
  h += fbmDamped(p0[0], p0[1], 3, 2.11, 0.55, 0.3) * 26.0;

  // medium drifts, domain sheared along the wind by the broad height so lee
  // faces steepen — dune asymmetry, near enough
  const p2 = windApply(w, 1.55, 1.0, 13.5, x, y);
  const med = fbmDamped(p2[0] + broad * 2.4, p2[1], 4, 2.07, 0.48, 1.7);

  // drifts pile where the broad form is concave, scour off exposed crests
  const shelter = Math.min(1, Math.max(0.15, 0.5 - broad * 0.75));
  h += med * 2.9 * shelter;

  return h * amp;
}
