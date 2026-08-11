// Shared world layout constants.
//
// The snowfield surface sits at waist height: in the headset you stand
// "buried to the hips" in powder, which puts the carvable surface exactly
// where your hands naturally sweep. (local-floor reference space, floor y=0.)
export const SNOW_Y = 0.85;

// The whole local world tilts about the spawn point — snowflow drops its
// wizard straight onto a slope, and standing on visible grade is most of
// what makes the place read as a mountain. Uphill is -Z (in front of you
// at spawn), downhill +Z. ~11 degrees: at the front edge of the 6 m field
// the snow reaches your chest, at the back edge it drops to your shins.
export const SLOPE_GRADE = 0.2;

// Base surface height (the un-carved snow plane) at a world xz near the
// origin. The dunes continue it outward and grow it into the full
// mountainside — for the true surface anywhere use
// terrain/terrainSurface.js.
export const surfaceY = (x, z) => SNOW_Y - SLOPE_GRADE * z;

// --- the giant ---------------------------------------------------------
// In the headset you are a giant standing partway up the mountainside: the
// camera rig is scaled by GIANT_SCALE and placed at RIG_POS, which puts
// the carve field (relocated onto the flank uphill of the rig) about
// thirty physical centimetres below your hands — a carving table — with
// the summit crest looming a few physical metres in front of you.
export const GIANT_SCALE = 60;
export const RIG_XZ = { x: 0, z: -100 };

// The carve field lives on the mountainside, uphill of the rig, within the
// giant's reach. World-space center of the sim field.
export const FIELD_CENTER = { x: 0, z: -140 };

// The carve field floats this far above the baked dune mesh so the two
// never z-fight (1.3 physical millimetres to the giant).
export const FIELD_LIFT = 0.05;
