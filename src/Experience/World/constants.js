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

// Base surface height (the un-carved snow plane) at a world xz. Exact over
// the carve field; the dunes continue it outward and grow it into the
// full mountainside.
export const surfaceY = (x, z) => SNOW_Y - SLOPE_GRADE * z;
