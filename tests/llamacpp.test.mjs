import test from "node:test";
import assert from "node:assert/strict";
import * as llamacpp from "../engines/llamacpp.mjs";
import { mockServer, tempFile, tokenSink } from "./helpers.mjs";

test("router: per-model tokens from the log, only loaded models polled", async () => {
  let slotsAsked = [];
  let busy = true;
  const srv = await mockServer({
    "/models": { data: [
      { id: "chat", status: { value: "loaded", args: ["--port", "53459", "--api-key", "secret"] } },
      { id: "cls", status: { value: "loaded", args: ["--port", "61447"] }, architecture: { output_modalities: ["decisions"] } },
      { id: "big", status: { value: "unloaded" } },
    ] },
    "/slots": (req, u) => { slotsAsked.push(u.searchParams.get("model")); return [{ id: 0, id_task: 1, is_processing: busy && u.searchParams.get("model") === "chat", next_token: [{ n_decoded: 5 }] }]; },
  });
  const log = tempFile("router.log");
  const sink = tokenSink();
  try {
    const e = llamacpp.create({ env: { DASH_LLAMA_URL: srv.url, DASH_LLAMA_LOG: log.file }, addTokens: sink.addTokens });
    await e.poll();
    log.append([
      "[53459] I slot launch_slot_: id  0 | task 7 | processing task, is_child = 0",
      "[53459] I slot print_timing: id  0 | task 7 | prompt eval time =  100.00 ms /    19 tokens (x)",
      "[53459] I slot print_timing: id  0 | task 7 |        eval time =  900.00 ms /   150 tokens (x)",
      "[61447] I slot launch_slot_: id  0 | task 9 | processing task, is_child = 0",
      "[61447] I slot      release: id  0 | task 9 | stop processing: n_tokens = 127, truncated = 0",
      "[53459] I slot      release: id  0 | task 7 | stop processing: n_tokens = 169, truncated = 0",   // text model: not counted
      "",
    ].join("\n"));
    const r = await e.poll();
    assert.equal(r.tokenSource, "log");
    assert.deepEqual(sink.got.get("chat"), { gen: 150, pp: 19, req: 1 });
    assert.deepEqual(sink.got.get("cls"), { gen: 0, pp: 127, req: 1 });
    assert.ok(!slotsAsked.includes("big"), "an unloaded model must never be asked (the router would load it)");
    assert.deepEqual(r.models.map((m) => [m.id, m.processing, m.kind]), [["chat", true, "text"], ["cls", false, "decisions"]]);

    const s = await e.setup();
    assert.equal(s.mode, "router");
    assert.deepEqual(s.models[0].args, [["api-key", "••••"]]);
  } finally { srv.close(); log.cleanup(); }
});

test("single server without a log: /metrics counters", async () => {
  let gen = 100;
  const srv = await mockServer({
    "/models": { data: [{ id: "/home/someone/models/solo.gguf" }] },   // a single server names the model by its -m path
    "/metrics": () => `llamacpp:tokens_predicted_total ${gen}\nllamacpp:prompt_tokens_total 40\n`,
    "/slots": [{ id: 0, id_task: 1, is_processing: false }],
  });
  const sink = tokenSink();
  try {
    const e = llamacpp.create({ env: { DASH_LLAMA_URL: srv.url }, addTokens: sink.addTokens });
    await e.poll();
    gen = 160;
    const r = await e.poll();
    assert.equal(r.tokenSource, "metrics");
    assert.equal(sink.got.get("solo.gguf").gen, 60);
  } finally { srv.close(); }
});

test("unreachable server throws (the server then backs off)", async () => {
  const e = llamacpp.create({ env: { DASH_LLAMA_URL: "http://127.0.0.1:9" }, addTokens: () => {} });
  await assert.rejects(e.poll());
});

test("DASH_LLAMA_URL empty disables the adapter", () => {
  assert.equal(llamacpp.create({ env: { DASH_LLAMA_URL: "" }, addTokens: () => {} }), null);
});
