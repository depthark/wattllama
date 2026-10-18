import test from "node:test";
import assert from "node:assert/strict";
import * as ollama from "../engines/ollama.mjs";
import { mockServer, tempFile, tokenSink } from "./helpers.mjs";

const HASH = "f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57";
// Real lines from Ollama 0.40.6 (paths shortened, one with a space in the user name).
const launch = (port) => `time=2026-10-18T19:36:24.705+02:00 level=INFO source=llama_server.go:457 msg="starting llama-server" cmd="C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Ollama\\lib\\ollama\\llama-server.exe --model C:\\Users\\Jane Doe\\.ollama\\models\\blobs\\sha256-${HASH} --port ${port} --host 127.0.0.1 --no-webui --offline -c 4096 -np 1 --log-verbosity 4 --no-log-prefix --no-log-timestamps --flash-attn auto"`;

test("parseLaunch: port, blob and arguments without folder names", () => {
  const x = ollama.parseLaunch(launch(65360));
  assert.equal(x.port, "65360");
  assert.equal(x.hash, HASH);
  assert.deepEqual(x.args, [["model", "sha256-f535f83ec568…"], ["no-webui", ""], ["offline", ""], ["c", "4096"], ["np", "1"], ["flash-attn", "auto"]]);
  assert.ok(!JSON.stringify(x).includes("Jane"));
  assert.equal(ollama.parseLaunch("time=x level=INFO msg=\"llama runner started\""), null);
});

test("tokens from server.log go to the loaded model; child /slots says when it generates", async () => {
  let busy = false;
  const child = await mockServer({ "/slots": () => [{ id: 0, id_task: 1, is_processing: busy, next_token: [{ n_decoded: 3 }] }] });
  const api = await mockServer({
    "/api/ps": { models: [{ name: "smollm2:135m", digest: "9077fe", details: { parameter_size: "134.52M", quantization_level: "F16" }, size: 381828463, context_length: 4096 }] },
    "/api/show": { modelfile: `# Modelfile\nFROM C:\Users\Jane Doe\.ollama\models\blobs\sha256-${HASH}\n`, capabilities: ["completion"] },
    "/api/tags": { models: [{ name: "smollm2:135m" }, { name: "nomic-embed-text:latest", details: {} }] },
  });
  const log = tempFile("server.log", launch(child.port) + "\n");
  const sink = tokenSink();
  try {
    const e = ollama.create({ env: { DASH_OLLAMA_URL: api.url, DASH_OLLAMA_LOG: log.file }, addTokens: sink.addTokens });
    let r = await e.poll();                       // child found by scanning back
    assert.equal(r.models[0].processing, false);
    busy = true;
    r = await e.poll();
    assert.equal(r.models[0].processing, true);
    busy = false;
    log.append([
      "slot launch_slot_: id  0 | task 0 | processing task, is_child = 0",
      "slot print_timing: id  0 | task 0 | prompt eval time =     913.74 ms /    36 tokens (   25.38 ms per token,    39.40 tokens per second)",
      "slot print_timing: id  0 | task 0 |        eval time =     249.83 ms /    17 tokens (   15.61 ms per token,    64.04 tokens per second)",
      "slot print_timing: id  0 | task 0 |       total time =    1163.57 ms /    53 tokens",
      "slot      release: id  0 | task 0 | stop processing: n_tokens = 52, truncated = 0", "",
    ].join("\n"));
    r = await e.poll();
    assert.equal(r.tokenSource, "log");
    assert.deepEqual(sink.got.get("smollm2:135m"), { gen: 17, pp: 36, req: 1 });
    const s = await e.setup();
    assert.deepEqual(s.models.map((m) => [m.id, m.status]), [["smollm2:135m", "loaded"], ["nomic-embed-text:latest", "unloaded"]]);
    assert.ok(s.models[0].args.some(([k, v]) => k === "ctx" && v === "4096"));
  } finally { child.close(); api.close(); log.cleanup(); }
});

test("OLLAMA_HOST is honoured, 0.0.0.0 becomes loopback", async () => {
  const e = ollama.create({ env: { OLLAMA_HOST: "0.0.0.0:11500", DASH_OLLAMA_LOG: "" }, addTokens: () => {} });
  assert.equal(e.url, "http://127.0.0.1:11500");
  const d = ollama.create({ env: {}, addTokens: () => {} });
  assert.equal(d.url, "http://127.0.0.1:11434");
});
