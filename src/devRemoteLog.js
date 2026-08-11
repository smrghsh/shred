// Dev-only remote console: mirrors console output, errors, and diagnostics
// to the vite dev server's /__log endpoint (see vite.config.js), which
// appends them to .dev-remote.log. Lets a Vision Pro Safari session be
// tailed live from a terminal — Safari's DOM (and any error overlay) is
// invisible while immersive, and Web Inspector needs a tethered Mac Safari.
//
// Imported unconditionally but a no-op outside `vite dev` (tree-shaken out
// of production builds by the import.meta.env.DEV guard).

export function installRemoteLog() {
  if (!import.meta.env.DEV) return;

  const send = (kind, parts) => {
    const line = `[${kind}] ${parts
      .map((p) => {
        if (p instanceof Error) return `${p.name}: ${p.message}\n${p.stack}`;
        if (typeof p === "object") {
          try {
            return JSON.stringify(p);
          } catch {
            return String(p);
          }
        }
        return String(p);
      })
      .join(" ")}`;
    // sendBeacon survives page/session teardown better than fetch
    try {
      if (!navigator.sendBeacon?.("/__log", line)) {
        fetch("/__log", { method: "POST", body: line, keepalive: true }).catch(() => {});
      }
    } catch {
      /* logging must never break the app */
    }
  };

  for (const kind of ["log", "warn", "error", "info"]) {
    const original = console[kind].bind(console);
    console[kind] = (...args) => {
      original(...args);
      send(kind, args);
    };
  }

  window.addEventListener("error", (e) =>
    send("uncaught", [`${e.message} @ ${e.filename}:${e.lineno}`])
  );
  window.addEventListener("unhandledrejection", (e) => send("unhandledrejection", [e.reason]));

  send("session", [`connected ${navigator.userAgent}`]);
}
