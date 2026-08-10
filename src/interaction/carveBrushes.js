// Board contact -> brush stamps, the snowflow_demo surf-wake recipe scaled
// to a fingerboard: three brushes per carving frame — a center groove
// (deep, compacting, elongated along the direction of travel) plus two
// pure-berm brushes offset to either side, weighted 0.5 +/- carve*0.5 so
// the outside of a turn throws the heavier wall.
//
// pose: {
//   x, z        board center, field-local meters
//   yaw         travel direction, radians (atan2(-dz, dx) convention)
//   moved       horizontal distance since last frame, meters
//   pen         penetration depth into the base snow plane, meters
//   carve       lean/turn direction, -1..1
// }
export default function carveBrushes(pose) {
  // depth scales with distance moved (framerate/speed-invariant, like
  // snowflow's walking scuff) and with how hard the board is pressed in
  const bite = Math.min(1, pose.pen / 0.04);
  const k = Math.min(pose.moved, 0.06) * bite;
  if (k <= 0) return [];

  const seed = (pose.x * 37.3 + pose.z * 17.9) % 10;
  const cos = Math.cos(pose.yaw);
  const sin = Math.sin(pose.yaw);
  // perpendicular to travel, in field xz (yaw rotates x toward -z)
  const px = sin;
  const pz = cos;

  const groove = {
    // the groove shifts slightly toward the lean, like a real carve
    x: pose.x + px * pose.carve * 0.018,
    z: pose.z + pz * pose.carve * 0.018,
    radius: 0.045,
    elongation: 2.6,
    yaw: pose.yaw,
    depth: k * 1.6,
    berm: 0,
    compression: k * 22, // clamped to 1 in-shader over a stroke
    edgeRoughness: 0.55,
    seed,
  };

  const walls = [-1, 1].map((side) => ({
    x: pose.x + px * side * 0.07,
    z: pose.z + pz * side * 0.07,
    radius: 0.055,
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
