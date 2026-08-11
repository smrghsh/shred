// Board contact -> brush stamps, the snowflow_demo surf-wake recipe scaled
// to the giant's board: three brushes per carving frame — a center groove
// (deep, compacting, elongated along the direction of travel) plus two
// pure-berm brushes offset to either side, weighted 0.5 +/- carve*0.5 so
// the outside of a turn throws the heavier wall.
//
// All length constants are 20x the original fingerboard tuning — the field
// grew from 6 m to 120 m of world when it moved onto the mountainside, and
// the giant's board grew with it.
//
// pose: {
//   x, z        board center, field-local meters
//   yaw         travel direction, radians (atan2(-dz, dx) convention)
//   moved       horizontal distance since last frame, meters
//   pen         penetration depth into the snow surface, meters
//   carve       lean/turn direction, -1..1
// }
export default function carveBrushes(pose) {
  // depth scales with distance moved (framerate/speed-invariant, like
  // snowflow's walking scuff) and with how hard the board is pressed in
  const bite = Math.min(1, pose.pen / 0.8);
  const k = Math.min(pose.moved, 1.2) * bite;
  if (k <= 0) return [];

  const seed = (pose.x * 37.3 + pose.z * 17.9) % 10;
  const cos = Math.cos(pose.yaw);
  const sin = Math.sin(pose.yaw);
  // perpendicular to travel, in field xz (yaw rotates x toward -z)
  const px = sin;
  const pz = cos;

  const groove = {
    // the groove shifts slightly toward the lean, like a real carve
    x: pose.x + px * pose.carve * 0.36,
    z: pose.z + pz * pose.carve * 0.36,
    radius: 0.9,
    elongation: 2.6,
    yaw: pose.yaw,
    depth: k * 1.6,
    berm: 0,
    compression: k * 1.1, // clamped to 1 in-shader over a stroke
    edgeRoughness: 0.55,
    seed,
  };

  const walls = [-1, 1].map((side) => ({
    x: pose.x + px * side * 1.4,
    z: pose.z + pz * side * 1.4,
    radius: 1.1,
    elongation: 2.0,
    yaw: pose.yaw,
    depth: 0,
    berm: k * 1.2 * (0.5 + side * pose.carve * 0.5),
    compression: 0,
    edgeRoughness: 1.0,
    seed: seed + side,
  }));

  return [groove, ...walls];
}
