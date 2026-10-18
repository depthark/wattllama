# Contributing to WattLlama

Thanks for helping! The most useful contributions right now:

1. **Share a result** from your PC, so [RESULTS.md](RESULTS.md) grows ([how](RESULTS.md)). No code needed.
2. **Confirm hardware.** Run WattLlama on an AMD Radeon or Intel Arc GPU (via LibreHardwareMonitor), an
   AMD CPU, a laptop or a multi-GPU PC, and open a [hardware report](../../issues/new?template=hardware.yml).
3. **Add an inference engine** (vLLM, KoboldCpp, llama-swap, Jan, text-generation-webui, ...). Each one
   is one file, explained below.
4. Pick an issue labelled [`good first issue`](../../labels/good%20first%20issue) or
   [`help wanted`](../../labels/help%20wanted).

## Ground rules

These are what WattLlama promises its users, so every change has to keep them:

- **Zero npm dependencies.** Node.js built-ins and Windows' own tools only. CI fails otherwise.
- **It is a monitor.** No measurable effect on generation speed: no polling faster than every 2 s,
  nothing that runs PowerShell or another process per poll, back off when an engine is not running.
- **Read-only and local.** Nothing leaves the PC. No new write endpoints; the GPU power limit is the
  single, guarded exception.
- **Never show secrets or paths.** API keys and tokens are masked, folders are cut to file names,
  prompts and replies are never stored, logged or shown.
- **No admin rights** for anything that is on by default.
- **Never crash the PC, never crash the page.** Catch errors per poll; a broken sensor shows "–".

## Develop

```powershell
git clone https://github.com/depthark/wattllama
cd wattllama
node server.mjs --demo     # 14 days of sample history in memory, http://127.0.0.1:8091
node --test tests/*.test.mjs
```

Use `DASH_PORT=8092` and `DASH_DATA_DIR=<temp folder>` to run a second copy next to an installed one.
The page is plain HTML, CSS and JavaScript in `public/`: no build step. Escape everything that comes
from an engine or a sensor with `esc()` before it goes into HTML.

## Adding an engine

An engine adapter is a file in `engines/` plus one line in [engines/index.mjs](engines/index.mjs).
[engines/llamacpp.mjs](engines/llamacpp.mjs), [engines/ollama.mjs](engines/ollama.mjs) and
[engines/lmstudio.mjs](engines/lmstudio.mjs) are complete examples.

```js
export const name = "My Engine";          // shown on the page; DASH_ENGINES=my engine selects it

export function create({ env, addTokens, log }) {
  const url = (env.DASH_MYENGINE_URL ?? "http://127.0.0.1:5000").replace(/\/$/, "");
  if (!url) return null;                  // empty setting = adapter off

  // Called every 2 s. Throw (e.g. connection refused) when the engine is not running:
  // WattLlama then only asks again every 10 s.
  async function poll() {
    // Report tokens as they finish: addTokens(modelId, generated, promptProcessed, requests)
    return {
      models: [{ id: "model-name", kind: "text", processing: false, genRate: 0,      // loaded models only
        busySec: 0 }],                    // optional: seconds of requests that finished unseen
                                          // since the last poll (engines that report afterwards)
      tokenSource: "log",                 // where counts come from: "log" | "metrics" | "slots" | ... | "none"
      note: undefined,                    // optional: one line shown when counts are limited
    };
  }

  // Called at most every 30 s for the Models section. Optional.
  async function setup() {
    return { mode: "my-engine", models: [{ id: "model-name", status: "loaded",
      args: [["ctx", "8192"]],            // [flag, value] chips: mask secrets, no paths (argPairs() does both)
      paramsText: "8B", size: 4.9e9 }] };
  }

  return { name, url, poll, setup, stop() {} };   // stop(): end child processes, if any
}
```

What makes an adapter good:

- **Exact counts first.** Prefer what the engine itself reports per request (its log, a metrics
  endpoint, per-request stats) over sampling live counters.
- **`processing` must be true while the model generates**, because busy time and energy per token
  are measured from it. If the engine only tells you about a request once it is finished (LM Studio),
  report its exact duration once in `busySec` instead.
- **Never load a model.** Some APIs load a model when you ask about it (llama.cpp's router does).
- **Cheap.** One or two local HTTP calls per poll. Start a long-running child process (like
  `lms log stream`) only while the engine answers, and kill it in `stop()`.
- **A test** in `tests/` with a fake server (`tests/helpers.mjs` has `mockServer`, `tempFile`,
  `tokenSink`) and, ideally, real log lines or responses captured from the engine.

Shared helpers in [engines/common.mjs](engines/common.mjs): `getJSON`, `tail` (follow a log file),
`parseLlamaLine` (llama-server log lines), `slotPoller` (llama-server `/slots`), `rate`, `argPairs`.
Many engines embed llama.cpp, so those often do most of the work.

## Pull requests

- One topic per PR, with a test when it changes behaviour.
- `node --test tests/*.test.mjs` passes, and you tried it in a browser (light and dark theme).
- Commits are small and say why. No force-pushes to `main`.

Security issues: please do not open a public issue, see [SECURITY.md](SECURITY.md).
