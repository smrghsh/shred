import "./style.css";
import Experience from "./Experience/Experience.js";
import SnowSim from "./snow/SnowSim.js";

const loading = document.getElementById("loading");

function setLoading(message, isError = false) {
  loading.style.display = "grid";
  loading.textContent = message;
  if (isError) loading.style.color = "#ff9b8a";
}

// Error overlay you can actually read (and dismiss) inside the headset —
// there is no console on the Vision Pro. Errors thrown while immersive are
// invisible (the DOM isn't rendered); they accumulate here so the whole
// sequence is waiting on screen after the session ends. The FIRST error is
// usually the informative one — everything after tends to be cascade.
const errorLog = [];
let lastLine = "";
let repeats = 0;

function appendError(line) {
  if (line === lastLine) {
    repeats++;
    errorLog[errorLog.length - 1] = `${line}  (x${repeats + 1})`;
  } else {
    lastLine = line;
    repeats = 0;
    if (errorLog.length < 14) errorLog.push(line);
    else if (errorLog.length === 14) errorLog.push("… (further errors dropped)");
  }
  showError(errorLog.join("\n"));
}
window.shredLog = appendError; // diagnostics hook for other modules

window.addEventListener("error", (e) => appendError(`Error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  appendError(`Unhandled rejection: ${e.reason?.message || e.reason}`)
);

function showError(message) {
  setLoading(`${message}\n\n(tap to dismiss)`, true);
  loading.style.whiteSpace = "pre-wrap";
  loading.style.padding = "0 32px";
  loading.style.fontSize = "13px";
  loading.style.textAlign = "left";
  loading.style.cursor = "pointer";
  loading.onclick = () => (loading.style.display = "none");
}

// Hand-rolled stand-in for three's VRButton. Same look, one difference that
// matters: three's button calls requestSession without a .catch, so when
// Safari rejects the required "webgpu" session feature (anything older than
// visionOS 26.2, or the feature flag switched off) the tap does nothing at
// all. This one puts the rejection on screen.
function createEnterVRButton(renderer) {
  const button = document.createElement("button");
  button.id = "VRButton";
  Object.assign(button.style, {
    position: "absolute",
    bottom: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "12px 24px",
    border: "1px solid #fff",
    borderRadius: "4px",
    background: "rgba(0,0,0,0.1)",
    color: "#fff",
    font: "normal 13px sans-serif",
    textAlign: "center",
    opacity: "0.5",
    outline: "none",
    zIndex: "999",
    cursor: "pointer",
  });
  button.onmouseenter = () => (button.style.opacity = "1.0");
  button.onmouseleave = () => (button.style.opacity = "0.5");

  if (!("xr" in navigator)) {
    button.textContent = "WEBXR NOT AVAILABLE";
    button.disabled = true;
    return button;
  }

  navigator.xr
    .isSessionSupported("immersive-vr")
    .then((supported) => {
      if (!supported) {
        button.textContent = "VR NOT SUPPORTED";
        button.disabled = true;
        return;
      }
      button.textContent = "ENTER VR";
      let session = null;
      button.onclick = async () => {
        if (session) {
          session.end();
          return;
        }
        button.textContent = "STARTING…";
        try {
          session = await navigator.xr.requestSession("immersive-vr", {
            requiredFeatures: ["webgpu"],
            optionalFeatures: ["hand-tracking", "local-floor"],
          });
          session.addEventListener("end", () => {
            session = null;
            button.textContent = "ENTER VR";
          });
          await renderer.xr.setSession(session);
          button.textContent = "EXIT VR";
        } catch (err) {
          console.error("XR session failed:", err);
          session = null;
          button.textContent = "ENTER VR";
          const s = `${err?.name || "Error"}: ${err?.message || err}`;
          const hint = /webgpu|feature|notsupported/i.test(s)
            ? "\n\nThis app renders XR through WebGPU, which needs visionOS 26.2+ Safari. If the OS is current, check Settings → Apps → Safari → Advanced → Feature Flags → WebXR (the WebGPU binding must be on)."
            : "";
          showError(`Enter VR failed — ${s}${hint}`);
        }
      };
    })
    .catch((err) => {
      button.textContent = "VR NOT SUPPORTED";
      button.disabled = true;
      showError(`isSessionSupported failed — ${err?.message || err}`);
    });

  return button;
}

async function main() {
  setLoading("loading…");

  if (!navigator.gpu) {
    throw new Error(
      "WebGPU is not available in this browser. Use recent Chrome/Edge, or Safari on visionOS 26."
    );
  }
  // xrCompatible matters: the device is shared with three's renderer, and
  // XRGPUBinding refuses a device whose adapter wasn't requested as
  // XR-compatible — the session then starts (browser fades) but no frames
  // are ever submitted. three does this itself when it owns the device;
  // handing it ours means doing it here.
  const adapter =
    (await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
      xrCompatible: true,
    })) || (await navigator.gpu.requestAdapter({ xrCompatible: true }));
  if (!adapter) throw new Error("WebGPU is available but no GPU adapter was found.");
  // core-features-and-limits just tells three's WebGPU backend it is not
  // running in compatibility mode.
  const requiredFeatures = [];
  if (adapter.features.has("core-features-and-limits"))
    requiredFeatures.push("core-features-and-limits");
  const device = await adapter.requestDevice({ requiredFeatures });
  device.addEventListener("uncapturederror", (e) => {
    console.error("WebGPU uncaptured error:", e.error?.message || e.error);
    appendError(`WebGPU: ${e.error?.message || e.error}`);
  });

  const sim = new SnowSim(device);

  const experience = new Experience(document.querySelector("canvas.webgl"));
  await experience.init({ device, sim });

  // The renderer runs on a WebGPU backend, so the XR session must be created
  // with the "webgpu" session feature (shipped on-by-default in visionOS 26
  // Safari 26.2) — required, not optional, so browsers without it fail to
  // start the session instead of coming up blank. hand-tracking is what the
  // summon gesture reads; visionOS prompts for permission.
  document.body.appendChild(createEnterVRButton(experience.renderer.instance));

  loading.style.display = "none";
}

main().catch((e) => {
  console.error(e);
  setLoading(String(e && e.message ? e.message : e), true);
});
