import "./style.css";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import Experience from "./Experience/Experience.js";
import SnowSim from "./snow/SnowSim.js";

const loading = document.getElementById("loading");

function setLoading(message, isError = false) {
  loading.style.display = "grid";
  loading.textContent = message;
  if (isError) loading.style.color = "#ff9b8a";
}

async function main() {
  setLoading("loading…");

  if (!navigator.gpu) {
    throw new Error(
      "WebGPU is not available in this browser. Use recent Chrome/Edge, or Safari on visionOS 26."
    );
  }
  const adapter =
    (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ||
    (await navigator.gpu.requestAdapter());
  if (!adapter) throw new Error("WebGPU is available but no GPU adapter was found.");
  // core-features-and-limits just tells three's WebGPU backend it is not
  // running in compatibility mode.
  const requiredFeatures = [];
  if (adapter.features.has("core-features-and-limits"))
    requiredFeatures.push("core-features-and-limits");
  const device = await adapter.requestDevice({ requiredFeatures });
  device.addEventListener("uncapturederror", (e) => {
    console.error("WebGPU uncaptured error:", e.error?.message || e.error);
  });

  const sim = new SnowSim(device);

  const experience = new Experience(document.querySelector("canvas.webgl"));
  await experience.init({ device, sim });

  // The renderer runs on a WebGPU backend, so the XR session must be created
  // with the "webgpu" session feature (shipped on-by-default in visionOS 26
  // Safari 26.2) — required, not optional, so browsers without it fail to
  // start the session instead of coming up blank. hand-tracking is what the
  // summon gesture reads; visionOS prompts for permission.
  document.body.appendChild(
    VRButton.createButton(experience.renderer.instance, {
      requiredFeatures: ["webgpu"],
      optionalFeatures: ["hand-tracking", "local-floor"],
    })
  );

  loading.style.display = "none";
}

main().catch((e) => {
  console.error(e);
  setLoading(String(e && e.message ? e.message : e), true);
});
