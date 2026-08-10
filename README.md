# shred

Carve fresh powder with your hands. A WebGPU snow-carving toy for Apple
Vision Pro (WebXR), with a desktop mouse fallback.

**The gesture:** in the headset, bring the index fingertips of your two hands
within 3 inches of each other — a snowboard pops in spanning the gap, nose at
one fingertip, tail at the other. Sweep it through the waist-high snow to
carve; tilt your hands to lean into a turn and throw the berm to the outside.
Spread your hands apart and the board vanishes.

On desktop: left-drag the snow to carve, right-drag to orbit.

## Technique

The deformation core is a reimplementation of the trail system in
[Noniv/snowflow_demo](https://github.com/Noniv/snowflow_demo), ported from a
Babylon.js fragment-pass ping-pong to a raw WGSL compute pass
(`src/snow/shaders/snowSim.wgsl`):

- One rgba32float state texture (1024² over a 6 m field) holds
  **depression** and **berm** as separate channels — surface offset is
  `berm - depression`. That separation is what makes a trail read as a
  carve-with-walls instead of a flat decal, and lets trenches refill slower
  than berms slump.
- Per frame: Laplacian relaxation (berms soften 3× faster), mass-conserving
  slump, slow weathering decay, then brush splats — a flat-floor core with a
  wobbled rim, a berm ring just outside it, and chunky grain noise.
- Carving writes snowflow's three-brush surf wake: a compacting center
  groove plus two side berm brushes weighted `0.5 ± carve·0.5`, so the
  outside of a turn throws the heavier wall.

The sim runs on the same `GPUDevice` as three's `WebGPURenderer` (the
caye/celeris pattern), so the state texture reaches the snow material through
one GPU→GPU copy per frame — no CPU readback. The snow surface is a TSL node
material: vertices displaced by manually-bilinear `textureLoad`s, normals
from central differences, compression darkening, blue "snow cave" occlusion
in the trenches, and hash-noise sparkle.

The world around the field is snowflow's too, ported wholesale
(`src/sky/`, `src/terrain/`):

- **Sky**: the Nishita single-scattering integral (verbatim WGSL via
  `wgslFn`) baked once into an equirect LUT, projected to 9 SH coefficients
  on the CPU, with the snow ground-bounce solved by iterating bake → SH →
  bounce — plus the Kasten-Young reddened 13° sun, its limb-darkened disc,
  aureole, and wind-aligned cirrus.
- **The far range**: snowflow's raymarched ridge heightfield, drawn in the
  sky-dome shader in a narrow band around the horizon and lit with the same
  wrapped-diffuse + SH + subsurface + aerial-perspective shading the snow
  uses, so it sits in the landscape instead of behind it.
- **The mountainside**: like snowflow's wizard, you spawn on a slope — the
  whole local world tilts ~11° about the spawn (uphill in front, the carve
  field rides the same plane). `terrainMacro` (wind-anisotropic,
  derivative-damped fBm) is baked into a polar mesh from the field edge out
  to 800 m, arriving at hip height metres from the field and at full ±20 m
  within a hundred; a quadratic flank steepens the uphill grade toward the
  peaks and eases the downhill run into a fog-filled valley, all converging
  onto the sky through the shared aerial fog.
- **One light everywhere**: every snow surface — carve field, dunes, far
  range — reads the same `sunRadiance` + SH ambient + Fresnel'd LUT sky
  reflection, and the frame is graded with AgX, both snowflow's picks.

Project structure follows the brahma convention: `Experience` singleton,
`src/Experience/brahma/` framework, `World/` scene objects, app code in
`src/`, assets in `static/`, GitHub-Pages build in `docs/`.

## Running

```bash
npm install
npm run dev        # https on your LAN (WebXR needs a secure context)
NO_SSL=1 npx vite  # plain http, desktop-only testing without cert warnings
```

On the Vision Pro (visionOS 26 / Safari 26.2+, where WebXR-from-WebGPU is on
by default): open `https://<your-mac-LAN-ip>:5173`, accept the self-signed
certificate, tap **Enter VR**, and allow hand tracking when prompted.

```bash
npm run build      # emits docs/ for GitHub Pages
```
