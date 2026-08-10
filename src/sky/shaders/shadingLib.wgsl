// Snow shading helpers shared by the sky dome's far range and (in TSL form)
// by the field materials. shadeRidgeP is snowflow_demo's shadeRidge with the
// Babylon material uniforms turned into parameters; the SH coefficients ride
// in a 9x1 float texture instead of a UBO array.

const INV_PI: f32 = 0.31830988618;

fn wrapDiffuse(ndl: f32, w: f32) -> f32 {
    return clamp((ndl + w) / (1.0 + w), 0.0, 1.0);
}

/// Back-lit translucency: snow with the sun behind it glows instead of going
/// to silhouette. A forward lobe bent slightly by the normal — an
/// approximation of the upstream snowSubsurface, which we don't have.
fn snowSubsurface(n: vec3f, l: vec3f, v: vec3f, radiance: vec3f, spread: f32, mask: f32, s: f32) -> vec3f {
    let bent = normalize(l + n * spread);
    let vl = clamp(dot(v, -bent), 0.0, 1.0);
    let glow = pow(vl, 4.0) * 0.5 + pow(vl, 24.0) * 0.5;
    return radiance * glow * mask * s * 0.35;
}

fn shLoad(shTex: texture_2d<f32>, i: i32) -> vec3f {
    return textureLoad(shTex, vec2i(i, 0), 0).rgb;
}

/// Irradiance for a normal from the 9 baked SH radiance coefficients
/// (Ramamoorthi-Hanrahan convolution, basis ordering as in the LUT bake).
fn shIrradianceTex(shTex: texture_2d<f32>, n: vec3f) -> vec3f {
    let L0 = shLoad(shTex, 0);
    let L1 = shLoad(shTex, 1);
    let L2 = shLoad(shTex, 2);
    let L3 = shLoad(shTex, 3);
    let L4 = shLoad(shTex, 4);
    let L5 = shLoad(shTex, 5);
    let L6 = shLoad(shTex, 6);
    let L7 = shLoad(shTex, 7);
    let L8 = shLoad(shTex, 8);
    return max(vec3f(0.0),
          L0 * 0.886227
        + (L1 * n.y + L2 * n.z + L3 * n.x) * 1.023328
        + (L4 * n.x * n.y + L5 * n.y * n.z + L7 * n.x * n.z) * 0.858086
        + L6 * 0.247708 * (3.0 * n.z * n.z - 1.0)
        + L8 * 0.429043 * (n.x * n.x - n.y * n.y));
}

/// Inscatter for a path of a given extinction — snowflow's aerialInscatterSky.
/// Converges on the exact sky sample at full extinction, so a fully hazed
/// surface and the sky pixel beside it are the same number.
fn aerialInscatterSkyP(
    lut: texture_2d<f32>, lutSamp: sampler, viewDir: vec3f,
    sunDir: vec3f, sunColor: vec3f, ext: f32
) -> vec3f {
    let exact = textureSampleLevel(lut, lutSamp, dirToLatLong(normalize(viewDir)), 0.0).rgb;

    let mu = dot(viewDir, sunDir);
    let fwd = phaseMie(mu, 0.62) * 5.5;
    let tilted = normalize(viewDir + vec3f(0.0, 0.42, 0.0));
    let near = textureSampleLevel(lut, lutSamp, dirToLatLong(tilted), 3.0).rgb
             + sunColor * fwd * 0.16;

    return mix(near, exact, smoothstep(0.55, 0.995, ext));
}

/// Shade a point on the far range — the snow field's material logic, not a
/// separate one, so the range sits in the same light as the ground.
fn shadeRidgeP(
    hit: RidgeHit, dir: vec3f, camPos: vec3f,
    sunDir: vec3f, sunColor: vec3f, sunRadiance: vec3f,
    shTex: texture_2d<f32>, ambientI: f32, ridgeAmp: f32,
    lut: texture_2d<f32>, lutSamp: sampler,
    fogDensity: f32, fogHeightFalloff: f32, fogStart: f32, aerialStrength: f32
) -> vec3f {
    let N = hit.normal;
    let L = sunDir;

    // Snow almost everywhere; rock only on faces too steep to hold it.
    let steep = 1.0 - N.y;
    let snowMask = clamp(1.0 - smoothstep(0.46, 0.80, steep), 0.0, 1.0);

    let rock = vec3f(0.052, 0.055, 0.066);
    let snow = vec3f(0.855, 0.885, 0.945);
    let albedo = mix(rock, snow, snowMask);

    let shadow = ridgeShadow(hit.pos, hit.height, L, ridgeAmp);

    let diff = wrapDiffuse(dot(N, L), mix(0.15, 0.62, snowMask));
    var col = albedo * INV_PI * sunRadiance * diff * shadow;

    // Subsurface: a mountain of snow with the sun behind it glows.
    let V = -dir;
    col += snowSubsurface(N, L, V, sunRadiance, 0.45, snowMask, 1.0)
         * albedo * mix(0.5, 1.0, shadow);

    // Sky fill — the reason distant snow reads blue rather than grey.
    col += albedo * INV_PI * shIrradianceTex(shTex, N) * ambientI;

    // Bounce off the range's own snow.
    col += albedo * INV_PI * shIrradianceTex(shTex, vec3f(0.0, 1.0, 0.0))
         * ambientI * 0.30 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0)
         * snowMask;

    // Aerial perspective: the scene's own atmosphere, not a second one.
    let hitPos = vec3f(hit.pos.x, hit.height, hit.pos.y);
    let t = aerialTransmittance(camPos, hitPos, fogDensity, fogHeightFalloff, fogStart);
    let ext = clamp(1.0 - pow(t, aerialStrength), 0.0, 1.0);
    let inscatter = aerialInscatterSkyP(lut, lutSamp, dir, L, sunColor, ext);

    return mix(col, inscatter, ext);
}
