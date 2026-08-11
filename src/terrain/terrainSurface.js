import { SNOW_Y, SLOPE_GRADE } from "../Experience/World/constants.js";
import { SKY } from "../sky/SkyLut.js";
import { terrainMacro } from "./terrainMacro.js";

// The one source of truth for "how high is the snow here": the mountainside
// base form (spawn-grade plane steepening uphill into the peak flank,
// easing downhill into the valley) plus the wind-carved terrainMacro
// landform, with relief growing by altitude. The dune mesh bakes exactly
// this; the carve field conforms to it; hands, board shadow, spray and the
// desktop raycast all ground against it. One function, no disagreements.

// Uphill flank steepening (see Dunes.js for the full rationale).
const FLANK = 0.0004;
// Downhill valley easing scale.
const VALLEY = 220;

const WIND_RAD = (SKY.windDirection * Math.PI) / 180;

/** Base landform without the dune/drift relief. */
export function terrainBaseY(x, z) {
  const uphill = Math.max(0, -z);
  const downhill = Math.max(0, z);
  return (
    SNOW_Y +
    SLOPE_GRADE * uphill +
    FLANK * uphill * uphill -
    (SLOPE_GRADE * downhill) / (1 + downhill / VALLEY)
  );
}

/** Full snow surface height: base + altitude-scaled terrainMacro relief. */
export function terrainSurfaceY(x, z) {
  const base = terrainBaseY(x, z);
  const r = Math.hypot(x, z);
  // capped so the far uphill reaches don't explode into noise spikes
  const alpine = 1 + Math.min(2.0, Math.max(0, base - SNOW_Y) * 0.006);
  const t = Math.min(1, Math.max(0, (r - 20) / 90));
  const amp = (0.25 + 0.75 * t * t * (3 - 2 * t)) * alpine;
  return base + terrainMacro(x, z, WIND_RAD) * amp;
}

/** Surface normal by central difference, written into `out` (THREE.Vector3-like). */
export function terrainSurfaceNormal(x, z, out, e = 1.5) {
  const hx = terrainSurfaceY(x + e, z) - terrainSurfaceY(x - e, z);
  const hz = terrainSurfaceY(x, z + e) - terrainSurfaceY(x, z - e);
  out.set(-hx / (2 * e), 1, -hz / (2 * e));
  out.normalize();
  return out;
}
