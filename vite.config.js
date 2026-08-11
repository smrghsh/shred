import fs from "node:fs";
import glsl from "vite-plugin-glsl";
import basicSsl from "@vitejs/plugin-basic-ssl";

// The brahma ecosystem convention: app code in src/, assets in static/,
// GitHub-Pages-ready build in docs/. HTTPS is on because WebXR requires a
// secure context — accept the self-signed certificate warning in dev
// (on the Vision Pro: visit the LAN URL, tap through the warning).
// NO_SSL=1 serves plain http for localhost-only work (localhost is a
// secure context, so WebGPU still runs — WebXR on a headset does not).
const noSsl = !!process.env.NO_SSL;

// Dev-only remote logging: the client (src/devRemoteLog.js) POSTs every
// console message / error / diagnostic here, and they land in
// .dev-remote.log next to this file — so a headset session can be tailed
// live from the terminal without Web Inspector.
const LOG_FILE = new URL("./.dev-remote.log", import.meta.url).pathname;
function remoteLog() {
  return {
    name: "shred-remote-log",
    configureServer(server) {
      fs.writeFileSync(LOG_FILE, `--- log opened ${new Date().toISOString()} ---\n`);
      server.middlewares.use("/__log", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const stamp = new Date().toISOString().slice(11, 23);
          fs.appendFileSync(LOG_FILE, `${stamp} ${body}\n`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

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
  plugins: noSsl ? [glsl(), remoteLog()] : [glsl(), basicSsl(), remoteLog()],
};
