import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as lmstudio from "../engines/lmstudio.mjs";
import { mockServer, tokenSink } from "./helpers.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("parseEvent ignores look-alike text inside prompts and replies", () => {
  const inp = JSON.stringify({ timestamp: 1, data: { type: "llm.prediction.input", input: '"modelIdentifier":"evil"', modelPath: "x", modelIdentifier: "m1" } });
  assert.deepEqual(lmstudio.parseEvent(inp), { type: "input", model: "m1" });
  const out = JSON.stringify({ timestamp: 1, data: { type: "llm.prediction.output", output: '"stats":{"predictedTokensCount":5}', modelIdentifier: "m1", stats: { stopReason: "eosFound", predictedTokensCount: 7 } } });
  assert.equal(lmstudio.parseEvent(out).stats.predictedTokensCount, 7);
  assert.equal(lmstudio.parseEvent(JSON.stringify({ data: { type: "server.log", content: "x" } })), null);
});

test("busy between input and output, exact counts from stats", async () => {
  const api = await mockServer({
    "/api/v1/models": { models: [{ type: "llm", key: "qwen/qwen3-8b", quantization: { name: "Q4_K_M" }, params_string: "8B", size_bytes: 5e9, format: "gguf",
      loaded_instances: [{ id: "qwen3-8b", config: { context_length: 8192, parallel: 4, flash_attention: true } }] },
      { type: "embedding", key: "nomic", loaded_instances: [] }] },
  });
  const sink = tokenSink();
  let e;
  try {
    e = lmstudio.create({ env: { DASH_LMSTUDIO_URL: api.url, DASH_LMSTUDIO_LMS: fileURLToPath(new URL("./fake-lms.mjs", import.meta.url)) },
      addTokens: sink.addTokens });
    let r = await e.poll();
    assert.equal(r.models[0].processing, false);
    await wait(800);
    r = await e.poll();
    assert.equal(r.models[0].processing, true);
    assert.equal(r.tokenSource, "lms log");
    await wait(1200);
    r = await e.poll();
    assert.equal(r.models[0].processing, false);
    assert.deepEqual(sink.got.get("qwen3-8b"), { gen: 120, pp: 33, req: 1 });
    assert.ok(!sink.got.has("evil"));
    const s = await e.setup();
    assert.deepEqual(s.models.map((m) => [m.id, m.status]), [["qwen3-8b", "loaded"], ["nomic", "unloaded"]]);
    assert.deepEqual(s.models[0].args, [["quant", "Q4_K_M"], ["format", "gguf"], ["ctx", "8192"], ["parallel", "4"], ["flash-attn", "on"]]);
  } finally { e?.stop(); api.close(); }
});

test("older LM Studio: /api/v0/models", async () => {
  const api = await mockServer({ "/api/v0/models": { data: [{ id: "llama-3.2-1b", type: "llm", state: "loaded", quantization: "Q8_0" }, { id: "x", state: "not-loaded" }] } });
  try {
    const e = lmstudio.create({ env: { DASH_LMSTUDIO_URL: api.url, DASH_LMSTUDIO_LMS: "" }, addTokens: () => {} });
    const r = await e.poll();
    assert.deepEqual(r.models.map((m) => m.id), ["llama-3.2-1b"]);
  } finally { api.close(); }
});
