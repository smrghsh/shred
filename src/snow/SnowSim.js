import snowSimShaderCode from "./shaders/snowSim.wgsl?raw";

// GPU snow-state simulation, run on the same GPUDevice as three's WebGPU
// backend (the caye/celeris pattern) so the renderer can consume the state
// texture with a GPU->GPU copy and never a CPU readback.
//
// Two rgba32float textures ping-pong through one compute pass per frame:
// read A -> relax + splat -> write B, swap. `texture` always points at the
// freshest state.

// The field covers a reach-sized patch of mountainside for the giant: 120 m
// of world at 1/60 scale is a 2 m carving table. All depth/berm limits are
// 20x the original 6 m-field tuning, so trenches read identically at the
// giant's eye.
export const FIELD_SIZE = 120; // meters per side, centered on FIELD_CENTER
export const FIELD_TEX = 1024; // texels per side (~12 cm/texel)
export const MAX_DEPTH = 3.2; // meters — trench clamp ("packed base")
export const MAX_BERM = 1.6;
export const MAX_BRUSHES = 16;

const BRUSH_FLOATS = 12; // three vec4s

export default class SnowSim {
  constructor(device) {
    this.device = device;

    const texDesc = {
      size: { width: FIELD_TEX, height: FIELD_TEX },
      format: "rgba32float",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    };
    // GPUTexture contents are zero-initialized — pristine flat snow.
    this.texA = device.createTexture({ ...texDesc, label: "snowStateA" });
    this.texB = device.createTexture({ ...texDesc, label: "snowStateB" });
    this.texture = this.texA; // freshest state

    this.paramsBuffer = device.createBuffer({
      label: "snowSimParams",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.brushBuffer = device.createBuffer({
      label: "snowSimBrushes",
      size: MAX_BRUSHES * BRUSH_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.paramsData = new Float32Array(8);
    this.brushData = new Float32Array(MAX_BRUSHES * BRUSH_FLOATS);

    this.pipeline = device.createComputePipeline({
      label: "snowSim",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: snowSimShaderCode }),
        entryPoint: "main",
      },
    });

    const layout = this.pipeline.getBindGroupLayout(0);
    const makeBindGroup = (srcTex, dstTex) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: dstTex.createView() },
          { binding: 2, resource: { buffer: this.paramsBuffer } },
          { binding: 3, resource: { buffer: this.brushBuffer } },
        ],
      });
    this.bindGroupAB = makeBindGroup(this.texA, this.texB);
    this.bindGroupBA = makeBindGroup(this.texB, this.texA);
  }

  // brushes: [{x, z, radius, elongation, yaw, depth, berm, compression,
  //            edgeRoughness, seed}], field-local meters. dt in seconds.
  step(brushes, dt) {
    const count = Math.min(brushes.length, MAX_BRUSHES);

    const p = this.paramsData;
    p[0] = Math.min(dt, 0.1);
    p[1] = count;
    p[2] = FIELD_SIZE;
    p[3] = FIELD_TEX;
    p[4] = MAX_DEPTH;
    p[5] = MAX_BERM;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);

    if (count > 0) {
      const b = this.brushData;
      for (let i = 0; i < count; i++) {
        const br = brushes[i];
        const o = i * BRUSH_FLOATS;
        b[o + 0] = br.x;
        b[o + 1] = br.z;
        b[o + 2] = br.radius;
        b[o + 3] = br.elongation ?? 1;
        b[o + 4] = Math.cos(br.yaw ?? 0);
        b[o + 5] = Math.sin(br.yaw ?? 0);
        b[o + 6] = br.depth ?? 0;
        b[o + 7] = br.berm ?? 0;
        b[o + 8] = br.compression ?? 0;
        b[o + 9] = br.edgeRoughness ?? 0.6;
        b[o + 10] = br.seed ?? 0;
        b[o + 11] = 0;
      }
      this.device.queue.writeBuffer(this.brushBuffer, 0, b, 0, count * BRUSH_FLOATS);
    }

    const readingA = this.texture === this.texA;
    const encoder = this.device.createCommandEncoder({ label: "snowSimStep" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, readingA ? this.bindGroupAB : this.bindGroupBA);
    const groups = Math.ceil(FIELD_TEX / 8);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.texture = readingA ? this.texB : this.texA;
  }
}
