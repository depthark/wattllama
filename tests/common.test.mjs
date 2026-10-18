import test from "node:test";
import assert from "node:assert/strict";
import { parseLlamaLine, argPairs, tail, rate } from "../engines/common.mjs";
import { tempFile } from "./helpers.mjs";

test("parseLlamaLine: router lines with [port] prefix", () => {
  assert.deepEqual(parseLlamaLine("[53459] 2640.01.613.794 I slot launch_slot_: id  0 | task 10412 | processing task, is_child = 0"), { req: 1 });
  assert.deepEqual(parseLlamaLine("[61447] 2317.16.271.342 I slot print_timing: id  0 | task 32283 | prompt eval time =    1501.12 ms /    19 tokens (   79.01 ms per token,    12.66 tokens per second)"), { pp: 19 });
  assert.deepEqual(parseLlamaLine("[61447] 2317.16.271.347 I slot print_timing: id  0 | task 32283 |        eval time =    4689.24 ms /   150 tokens (   31.47 ms per token,    31.77 tokens per second)"), { gen: 150 });
  assert.deepEqual(parseLlamaLine("[53459] 2640.03.230.051 I slot      release: id  0 | task 10412 | stop processing: n_tokens = 127, truncated = 0"), { release: 127 });
});

test("parseLlamaLine: no prefix, no timestamps (as Ollama runs llama-server)", () => {
  assert.deepEqual(parseLlamaLine("slot print_timing: id  0 | task 2 |        eval time =     812.10 ms /    42 tokens (   19.34 ms per token,    51.72 tokens per second)"), { gen: 42 });
});

test("parseLlamaLine: other lines are ignored", () => {
  assert.equal(parseLlamaLine("[61447] slot print_timing: id  0 | task 32283 | draft acceptance = 0.71311 (   87 accepted /   122 generated), mean len =  2.43"), null);
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
