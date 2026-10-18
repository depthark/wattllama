import test from "node:test";
import assert from "node:assert/strict";
import { parseLlamaLine, argPairs, tail, rate, requestAssembler } from "../engines/common.mjs";
import { tempFile } from "./helpers.mjs";

test("parseLlamaLine: router lines with [port] prefix", () => {
  assert.deepEqual(parseLlamaLine("[53459] 2640.01.613.794 I slot launch_slot_: id  0 | task 10412 | processing task, is_child = 0"), { req: 1, task: 10412 });
  assert.deepEqual(parseLlamaLine("[61447] 2317.16.271.342 I slot print_timing: id  0 | task 32283 | prompt eval time =    1501.12 ms /    19 tokens (   79.01 ms per token,    12.66 tokens per second)"), { pp: 19, ms: 1501.12, task: 32283 });
  assert.deepEqual(parseLlamaLine("[61447] 2317.16.271.347 I slot print_timing: id  0 | task 32283 |        eval time =    4689.24 ms /   150 tokens (   31.47 ms per token,    31.77 tokens per second)"), { gen: 150, ms: 4689.24, task: 32283 });
  assert.deepEqual(parseLlamaLine("[53459] 2640.03.230.051 I slot      release: id  0 | task 10412 | stop processing: n_tokens = 127, truncated = 0"), { release: 127, task: 10412 });
});

test("parseLlamaLine: no prefix, no timestamps (as Ollama runs llama-server)", () => {
  assert.deepEqual(parseLlamaLine("slot print_timing: id  0 | task 2 |        eval time =     812.10 ms /    42 tokens (   19.34 ms per token,    51.72 tokens per second)"), { gen: 42, ms: 812.1, task: 2 });
});

test("parseLlamaLine: other lines are ignored", () => {
  assert.deepEqual(parseLlamaLine("[61447] slot print_timing: id  0 | task 32283 | draft acceptance = 0.71311 (   87 accepted /   122 generated), mean len =  2.43"), { draftAcc: 87, draftGen: 122, task: 32283 });
  assert.equal(parseLlamaLine("[61447] I slot print_timing: id  0 | task 44964 | n_gen =    159, tg =  52.50 t/s, tg_3s =  52.83 t/s"), null, "progress lines are not results");
  assert.equal(parseLlamaLine("srv  log_server_r: request: POST /v1/chat/completions 127.0.0.1 200"), null);
  assert.equal(parseLlamaLine(""), null);
});

test("argPairs masks secrets, shortens paths, drops plumbing flags", () => {
  const a = argPairs(["--model", "C:\\Users\\someone\\models\\Qwen.gguf", "--port", "61447", "--api-key", "sk-123",
    "--jinja", "-c", "8192", "-ngl", "-1", "--host", "127.0.0.1", "--ssl-key-file", "/etc/key.pem"]);
  assert.deepEqual(a, [["model", "Qwen.gguf"], ["api-key", "••••"], ["jinja", ""], ["c", "8192"], ["ngl", "-1"], ["ssl-key-file", "••••"]]);
  assert.ok(!JSON.stringify(a).includes("sk-123"));
  assert.ok(!JSON.stringify(a).includes("someone"));
});

test("tail reads only new complete lines and survives a replaced file", () => {
  const f = tempFile("x.log", "old line\n");
  try {
    const read = tail(f.file);
    assert.deepEqual(read(), []);                       // starts at the end
    f.append("one\ntwo\npart");
    assert.deepEqual(read(), ["one", "two"]);
    f.append("ial\n");
    assert.deepEqual(read(), ["partial"]);
    f.cleanup();
    assert.equal(read(), null);                         // gone
  } finally { f.cleanup(); }
});

test("rate is 0 when idle and smoothed while generating", () => {
  assert.equal(rate(40, false, 100, 2), 0);
  assert.equal(rate(undefined, true, 100, 2), 50);
  assert.equal(rate(40, true, 100, 2), 45);
});

test("requestAssembler: one record per request, from real router lines", () => {
  const got = [];
  const feed = requestAssembler((r) => got.push(r), { nCtxOf: () => 65536, now: () => 1000 });
  const lines = [
    "[61447] I slot launch_slot_: id  0 | task 44964 | processing task, is_child = 0",
    "[61447] I slot print_timing: id  0 | task 44964 | n_gen =    159, tg =  52.50 t/s, tg_3s =  52.83 t/s",
    "[61447] I slot print_timing: id  0 | task 44964 | prompt eval time =     358.90 ms /    22 tokens (   16.31 ms per token,    61.30 tokens per second)",
    "[61447] I slot print_timing: id  0 | task 44964 |        eval time =    4108.01 ms /   206 tokens (   20.04 ms per token,    49.90 tokens per second)",
    "[61447] I slot print_timing: id  0 | task 44964 | draft acceptance = 0.61413 (  113 accepted /   184 generated), mean len =  2.23",
    "[61447] I slot      release: id  0 | task 44964 | stop processing: n_tokens = 8034, truncated = 0",
  ];
  for (const l of lines) feed("qwen", "text", parseLlamaLine(l));
  assert.deepEqual(got, [{ ts: 1000, model: "qwen", pp: 22, ppMs: 358.9, gen: 206, genMs: 4108.01, draftAcc: 113, draftGen: 184, ctx: 8034, cached: 7806, nCtx: 65536 }]);
});

test("requestAssembler: classifiers record what they read; empty text requests are skipped", () => {
  const got = [];
  const feed = requestAssembler((r) => got.push(r));
  feed("d1", "decisions", { req: 1, task: 9 });
  feed("d1", "decisions", { release: 127, task: 9 });
  feed("qwen", "text", { req: 1, task: 3 });
  feed("qwen", "text", { release: 50, task: 3 });
  assert.equal(got.length, 1);
  assert.equal(got[0].pp, 127);
});
