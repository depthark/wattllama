<p align="center">
  <img src="docs/logo.svg" width="120" alt="WattLlama logo: a lightning bolt shaped like a llama">
</p>

<h1 align="center">WattLlama</h1>

<p align="center">
  <b>How many watts does your local LLM really burn?</b><br>
  A live power, temperature and energy-per-token dashboard for Windows PCs running
  <b>llama.cpp</b>, <b>Ollama</b> or <b>LM Studio</b>.<br>
  No drivers, no admin rights, no Docker, no npm packages. One small Node.js process.
</p>

<p align="center">
  <a href="https://github.com/depthark/wattllama/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/depthark/wattllama/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4">
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/Node.js-22.13%2B-339933">
  <img alt="Engines" src="https://img.shields.io/badge/engines-llama.cpp%20%7C%20Ollama%20%7C%20LM%20Studio-ffd23f">
  <img alt="0 dependencies" src="https://img.shields.io/badge/dependencies-0-2ee6d6">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-a06bff">
</p>

![WattLlama tour: overview, hardware, models, light and dark theme](docs/tour.gif)

## Why

Running models locally is "free" until you look at what the PC draws while it thinks.
WattLlama answers the questions a local-LLM user actually has:

- **What does my PC draw right now?** GPU, CPU and RAM measured, the rest estimated, split in a stacked chart.
- **How much energy did today / this week / this month take, and how much of it was the LLM?**
  Every minute is stored, and minutes in which a model was generating are marked.
- **What does a token cost in energy?** Wh per 1,000 tokens and kWh per million, per model and per run.
- **When do I use it?** A day × hour heatmap of tokens, energy or busy time, like GitHub's contribution graph.
- **Is my GPU power limit costing me speed?** Generate at different limits and the efficiency table
  shows tokens per second and tokens per Wh for each, the "same speed for 100 W less" check
  from GPU undervolting videos, but for LLM inference.
- **How does my PC compare?** Share your numbers in one click to the [community results](RESULTS.md).

It does not matter which chat app, agent or IDE plugin you use: WattLlama watches the **engine**,
so every client that talks to it is counted.

## Features

| | |
|---|---|
| ⚡ **Power** | Whole-PC watts (GPU, CPU package, RAM measured; rest + PSU loss estimated), history from 1 hour to 30 days, cumulative energy curve |
| 🦙 **Every model separately** | llama.cpp (server or router), Ollama and LM Studio, several models and engines at once: live state, tok/s, requests, tokens in/out, busy time, energy while busy |
| 🔥 **Heatmap** | Day × hour grid of tokens, energy or busy time for all models or one, 7 / 14 / 30 days |
| 🌡️ **Hardware** | NVIDIA: temperature, fan, clocks, VRAM, P-state, PCIe link, *why it is throttled*. CPU load, effective clock, RAM, disk I/O. With [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) (optional): CPU core temperatures, fans, SSDs, and **AMD Radeon / Intel Arc** GPU power |
| 🎚️ **GPU power limit** | Optional: set the NVIDIA power limit from the page (UAC-confirmed, safe range) and compare efficiency per limit |
| 📋 **Runs** | One row per generation run: model, duration, requests, tokens, tok/s, Wh, Wh per 1k tokens |
| 🏆 **Community results** | Turn your numbers into a prefilled GitHub issue for [RESULTS.md](RESULTS.md); you see exactly what is shared |
| ⚙️ **Setup at a glance** | The real arguments each model runs with (secrets masked), [pi](https://github.com/badlogic/pi-mono) agent settings if you use it, chosen Windows scheduled tasks with last/next run |
| 📤 **CSV export** | Minutes, per-model minutes and runs, for your own spreadsheets |
| 🌓 **Light & dark** | Follows Windows, or pick one |
| 🪶 **Featherweight** | Measured: **0.02 % CPU, ~150 MB RAM** in total; generation speed unchanged (54–60 tok/s with and without it) |

<details>
<summary>Screenshots</summary>

![Dark theme](docs/screenshot-dark.png)
![Light theme](docs/screenshot-light.png)
![Hardware and power limit](docs/hardware.png)
![Models from llama.cpp and Ollama side by side, with their arguments](docs/models.png)
![Share your result](docs/share.png)

</details>

## Install

Requirements: Windows 10 (1809+) or 11, [Node.js](https://nodejs.org) 22.13 or newer
(`winget install OpenJS.NodeJS.LTS`). A GPU and an inference engine are optional; without them you
get CPU and system power only.

```powershell
git clone https://github.com/depthark/wattllama
cd wattllama
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer checks what your PC can measure and which engines are running, creates `.env`,
registers a scheduled task that starts WattLlama when you log in (current user, no admin), and
opens **http://127.0.0.1:8091**.

Just want to look first? `node server.mjs --demo` serves the page with 14 days of sample history
(in memory, nothing saved).

Uninstall: `.\uninstall.ps1` (keeps your history in `data\`; add `-RemoveData` to delete it).

## Connect your engine

All three are found automatically on their default ports. An engine that is not running costs
nothing; it is asked again every 10 s and appears when you start it.

| Engine | Found at | Tokens | Generating now |
|---|---|---|---|
| **llama.cpp** `llama-server`, router too | `DASH_LLAMA_URL` (:8080) | exact from its log (`DASH_LLAMA_LOG`) or `--metrics`; else `/slots` (close) | `/slots` |
| **Ollama** (the app or `ollama serve`) | `OLLAMA_HOST` or :11434 | exact from `%LOCALAPPDATA%\Ollama\server.log`; else `/slots` (close) | the model's llama-server `/slots` |
| **LM Studio** (Developer → Start server) | `DASH_LMSTUDIO_URL` (:1234) | exact, LM Studio's own stats via `lms log stream` | between a prediction's start and end |

<details>
<summary>Details per engine</summary>

**llama.cpp.** Works with a single `llama-server` and with the router (`--models-dir` /
`--models-preset`) with any number of loaded models. For exact counts, redirect the server's output
to a file and point `DASH_LLAMA_LOG` at it, or start it with `--metrics`. If it uses `--api-key`,
set `DASH_LLAMA_API_KEY`. WattLlama never asks the router about a model that is not loaded, because
that would load it.

**Ollama.** Recent Ollama (tested with 0.40.6) runs each model as an upstream llama-server process and writes its
output to `server.log`, which gives the same exact counts. The **prefill** column counts tokens that
were actually computed; prompt-cache hits are not counted (Ollama's `prompt_eval_count` includes them).
Models served by another Ollama runner show as loaded, without token counts.

**LM Studio.** Token counts need the `lms` CLI, which LM Studio installs in
`%USERPROFILE%\.lmstudio\bin`. WattLlama starts `lms log stream` only while the server answers and
always with an explicit port, so it never launches LM Studio. Prompts and replies pass through that
stream; WattLlama reads only the model name and the numbers, and never stores, logs or shows text.

**Something else?** vLLM, KoboldCpp, llama-swap, Jan, … An adapter is one file:
see [CONTRIBUTING.md](CONTRIBUTING.md#adding-an-engine).

</details>

### Phone / other devices

```powershell
.\install.ps1 -AllowLan
```

Serves on your network, adds a firewall rule for private networks only, and sets a random access
token. It prints a link to open once on the phone. Handy because a browser tab on the same PC
uses some VRAM, which matters when the model fills the card.

### CPU temperatures, fans, SSDs, AMD and Intel GPUs

Windows has no driver-free way to read CPU core temperatures, or the power of AMD and Intel GPUs. Run
[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor), enable
*Options → Remote Web Server → Run*, and set `DASH_LHM_URL=http://127.0.0.1:8085`. Every temperature
and fan it sees shows up, CPU temperature joins the history chart, and discrete Radeon and Arc cards
get a GPU card and count towards whole-PC watts. (Integrated graphics are already inside the CPU
package power.)

### GPU power limit

Off by default. With `DASH_ALLOW_POWER_LIMIT=1` each NVIDIA card gets a slider:

- only from the PC itself (not from the network), only from WattLlama's own page;
- only between **60 % of the card's default** and its maximum, inside the range NVIDIA's driver allows;
- Windows asks you in a **UAC prompt** every time;
- it is a power cap, **not an undervolt**: it cannot make the PC unstable, worst case the card is slower;
- it **resets on reboot**.

Then run your usual prompts at a few limits and read the *Efficiency by GPU power limit* table.

## How it measures

| What | Source | Accuracy |
|---|---|---|
| NVIDIA GPU power, temperature, clocks, VRAM, throttle reasons | `nvidia-smi` streaming every 2 s, one process | measured |
| AMD / Intel Arc GPU power, temperature, load, VRAM | LibreHardwareMonitor (optional) | measured |
| CPU package and RAM power | Windows *Energy Meter* (RAPL) counters where Windows exposes them (most Intel desktop CPUs), read through the PDH API with English counter names, so any Windows display language works | measured |
| CPU load, effective clock, disk I/O, ACPI zone | Windows performance counters | measured |
| Rest of the PC (motherboard, disks, fans) | `DASH_REST_W` (35 W) | estimate |
| Power supply loss | divided by `DASH_PSU_EFF` (0.88) | estimate |
| Monitor | not counted | |
| CPU power on PCs without RAPL counters | from load × `DASH_CPU_MAX_W` | estimate, marked "(est.)" |
| Tokens, requests, generating or not | the engine, see [Connect your engine](#connect-your-engine) | exact or close |

For exact wall-socket numbers, nothing beats a smart plug with energy metering; WattLlama tells you
*where* the watts go and how much of it the LLM caused.

History lives in `data/power.db` (SQLite, built into Node.js): one row per minute, roughly 5–7 MB a
month. Export it as CSV from the links next to the chart ranges.

## Compared with popular tools

| | LLM tokens & energy per token | Power history (kWh) | GPU + CPU sensors | Windows, no admin | Setup |
|---|---|---|---|---|---|
| **WattLlama** | ✅ per model, per run, 3 engines | ✅ | ✅ (+ LHM) | ✅ | one script |
| [MSI Afterburner](https://www.msi.com/Landing/afterburner/graphics-cards) | ❌ | ❌ (log file) | ✅ GPU | admin | GUI app |
| [HWiNFO](https://www.hwinfo.com) | ❌ | ❌ (CSV log) | ✅ | admin driver | GUI app |
| [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) | ❌ | ❌ | ✅ | admin driver | GUI app (WattLlama can read it) |
| [nvitop](https://github.com/XuehaiPan/nvitop) / [nvtop](https://github.com/Syllo/nvtop) | ❌ | ❌ | GPU only | nvitop yes / nvtop Linux | terminal |
| [btop](https://github.com/aristocratos/btop) / [Glances](https://github.com/nicolargo/glances) | ❌ | ❌ | ✅ | partly | terminal / web |
| [Beszel](https://github.com/henrygd/beszel) | ❌ | ✅ | ✅ | agent | hub + agent |
| Grafana + exporters | with work | ✅ | ✅ | services | 3+ services |
| LM Studio / Ollama / llama.cpp UIs | tok/s per message | ❌ | ❌ | ✅ | built in |

WattLlama does not replace a hardware monitor; it connects the watts to the tokens.

## Security

WattLlama is a read-only monitor that runs as your user.

- Listens on **127.0.0.1** only, unless you choose `-AllowLan` (then a random token is required).
- **No dependencies**: Node.js built-ins and Windows' own tools only, nothing to supply-chain.
- **GET only**, a fixed list of files (no path ever comes from the URL), strict
  **Content-Security-Policy**, `X-Frame-Options: DENY`, `nosniff`, no CORS.
- **DNS-rebinding protection**: requests whose `Host` is a foreign domain are refused, so a website
  you visit cannot read the dashboard through your browser.
- Never shows secrets: `--api-key` and similar arguments are masked, file paths are shortened to
  file names, pi's `auth.json` and API keys are never read, prompts and replies are never stored.
- Nothing is sent anywhere. *Share your result* only opens a GitHub page with what you saw.
- The single optional write action (GPU power limit) is described above: off by default, local
  only, same-origin with a custom header (blocks CSRF), range-checked, UAC-confirmed.
- Crash-safe: an unexpected error is logged and the process restarts; it never touches drivers,
  clocks, fans or voltages.
- CI runs the HTTP security rules as tests on every change.

See [SECURITY.md](SECURITY.md) for reporting.

## Configuration

Everything lives in `.env` (see [.env.example](.env.example)); all settings are optional.

| Setting | Default | |
|---|---|---|
| `DASH_HOST` / `DASH_PORT` | `127.0.0.1` / `8091` | where the page is served |
| `DASH_ENGINES` | `auto` | or a list, e.g. `ollama,lm studio` |
| `DASH_LLAMA_URL` | `http://127.0.0.1:8080` | llama.cpp server or router; empty = off |
| `DASH_LLAMA_LOG` | – | llama-server log file, for exact token counts |
| `DASH_LLAMA_API_KEY` | – | if the server uses `--api-key` |
| `DASH_OLLAMA_URL` | `OLLAMA_HOST` or `:11434` | empty = off |
| `DASH_OLLAMA_LOG` | `%LOCALAPPDATA%\Ollama\server.log` | Ollama's log, for exact token counts |
| `DASH_LMSTUDIO_URL` | `http://127.0.0.1:1234` | empty = off |
| `DASH_LMSTUDIO_API_KEY` / `DASH_LMSTUDIO_LMS` | – / found | if the server requires a token / path to `lms` |
| `DASH_REST_W` / `DASH_PSU_EFF` | `35` / `0.88` | the estimated part |
| `DASH_CPU_MAX_W` | `65` | only used without RAPL counters |
| `DASH_LHM_URL` | – | LibreHardwareMonitor web server |
| `DASH_ALLOW_POWER_LIMIT` | `0` | NVIDIA power limit control |
| `DASH_TOKEN` | – | require a token (set by `-AllowLan`) |
| `DASH_TASKS` | – | scheduled tasks to show, e.g. `Backup*,MyLLM` |
| `DASH_PI_DIR` | `~/.pi/agent` | pi agent settings |

## Contributing

Help is very welcome, and much of it needs no code: **share a result** from your PC, or **report how
it measures** on an AMD / Intel GPU, an AMD CPU or a laptop. New engines are one file each.
Everything is in [CONTRIBUTING.md](CONTRIBUTING.md); look for
[`good first issue`](https://github.com/depthark/wattllama/labels/good%20first%20issue).

## License

MIT
