// Snow state simulation — one compute dispatch per frame over the whole field.
//
// State texture (rgba32float, FIELD_TEX x FIELD_TEX texels over FIELD_SIZE m):
//   R = depression depth in meters (positive down — carved out by the board)
//   G = displaced mass / berm in meters (positive up — thrown to the sides)
//   B = compression 0..1 (packed snow in the trench floor, shades darker)
//   A = unused
// Surface offset applied by the renderer = G - R. Keeping trench and pile in
// separate channels (the snowflow_demo trick) is what makes a trail read as a
// carve-with-walls instead of a flat decal, and lets them relax at different
// rates: berms slump ~3x faster than trenches refill.
//
// Per frame: relax (diffuse + slump + decay) then splat this frame's brushes.
// rgba32float sidesteps snowflow's f16-ULP decay quantization entirely.

struct Params {
  dt: f32,          // seconds, 0 = splat only
  brushCount: f32,
  fieldSize: f32,   // meters
  texN: f32,        // texels per side
  maxDepth: f32,    // trench clamp — "you hit packed base"
  maxBerm: f32,
  _pad0: f32,
  _pad1: f32,
};

// Brush = one elliptical stamp, all coordinates in field-local meters.
//   a: (centerX, centerZ, radius, elongation)
//   b: (cosYaw, sinYaw, depth, berm)
//   c: (compression, edgeRoughness, seed, unused)
struct Brush {
  a: vec4f,
  b: vec4f,
  c: vec4f,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> brushes: array<Brush>;

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

// cheap value noise, ~[-1, 1]
fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

fn loadClamped(ip: vec2i, n: i32) -> vec4f {
  return textureLoad(src, clamp(ip, vec2i(0), vec2i(n - 1)), 0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = i32(params.texN);
  if (gid.x >= u32(n) || gid.y >= u32(n)) {
    return;
  }
  let ip = vec2i(gid.xy);
  var s = textureLoad(src, ip, 0);

  // field-local world position of this texel (field centered on origin)
  let world = (vec2f(gid.xy) + 0.5) / params.texN * params.fieldSize
            - params.fieldSize * 0.5;

  // --- relax: diffusion + slump + decay ------------------------------------
  let dt = params.dt;
  if (dt > 0.0) {
    let sN = loadClamped(ip + vec2i(0, 1), n);
    let sS = loadClamped(ip - vec2i(0, 1), n);
    let sE = loadClamped(ip + vec2i(1, 0), n);
    let sW = loadClamped(ip - vec2i(1, 0), n);
    let lap = sN + sS + sE + sW - 4.0 * s;

    // frame-rate-normalized rates (k ~= 1 at 60 fps), snowflow's constants
    let k = dt * 60.0;
    let kDep = min(0.22, 0.004 * k);
    let kBerm = min(0.22, 0.012 * k); // berm edges soften 3x faster
    s.x += kDep * lap.x;
    s.y += kBerm * lap.y;

    // slump: berm mass falls back into the trench it sits beside
    // (mass-conserving — removes equal amounts from both channels)
    let slump = min(s.y, s.x) * min(0.6, 0.12 * dt);
    s.x -= slump;
    s.y -= slump;

    // slow weathering — trails fade over minutes
    s.x *= exp(-dt / 400.0);
    s.y *= exp(-dt / 250.0);
    s.z *= exp(-dt / 300.0);
  }

  // --- splat this frame's brushes ------------------------------------------
  // Edge fade applied to the *contribution* (not the accumulated state, which
  // would erode the interior every frame): displacement dies out before the
  // field boundary so the mesh meets the surrounding flat snow cleanly.
  let edge = max(abs(world.x), abs(world.y)) / (params.fieldSize * 0.5);
  let fade = 1.0 - smoothstep(0.82, 0.97, edge);

  let count = u32(params.brushCount);
  for (var i = 0u; i < count; i++) {
    let br = brushes[i];
    let p = world - br.a.xy;
    let radius = br.a.z;
    let elong = br.a.w;
    // rotate into brush space, divide the long axis by radius*elongation
    let q = vec2f(
      (p.x * br.b.x + p.y * br.b.y) / (radius * elong),
      (-p.x * br.b.y + p.y * br.b.x) / radius
    );
    let d = length(q);
    if (d < 2.2) {
      // wobble the rim so trench edges look crumbled, not machined
      let ang = atan2(q.y, q.x);
      let wob = 1.0 + br.c.y * 0.22 * noise2(vec2f(cos(ang), sin(ang)) * 2.7 + br.c.z);
      let dn = d / wob;
      // flat floor with a fast shoulder (deliberately not a gaussian),
      // and a berm ring sitting just outside the rim
      let core = 1.0 - smoothstep(0.42, 1.0, dn);
      let ringD = (dn - 1.04) * 3.4;
      let ring = exp(-ringD * ringD);
      // chunky granulation so thrown snow reads as clumps
      let grain = 0.72 + 0.56 * (noise2(q * 7.5 + br.c.z * 3.1) * 0.5 + 0.5);

      s.x += br.b.z * core * fade;
      s.y += br.b.w * ring * grain * fade;
      s.z += br.c.x * core * fade;
    }
  }

  s = vec4f(
    clamp(s.x, 0.0, params.maxDepth),
    clamp(s.y, 0.0, params.maxBerm),
    clamp(s.z, 0.0, 1.0),
    0.0
  );
  textureStore(dst, ip, s);
}
