import glsl from "vite-plugin-glsl";
import basicSsl from "@vitejs/plugin-basic-ssl";

// The brahma ecosystem convention: app code in src/, assets in static/,
// GitHub-Pages-ready build in docs/. HTTPS is on because WebXR requires a
// secure context — accept the self-signed certificate warning in dev
// (on the Vision Pro: visit the LAN URL, tap through the warning).
// NO_SSL=1 serves plain http for localhost-only work (localhost is a
// secure context, so WebGPU still runs — WebXR on a headset does not).
const noSsl = !!process.env.NO_SSL;

export default {
  root: "src/",
  publicDir: "../static/",
  base: "./",
  server: {
    host: true, // reachable from headsets on your LAN
    https: !noSsl,
  },
  build: {
    outDir: "../docs",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
  },
  plugins: noSsl ? [glsl()] : [glsl(), basicSsl()],
};
