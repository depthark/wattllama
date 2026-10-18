<p align="center">
  <img src="docs/logo.svg" width="120" alt="WattLlama logo: a lightning bolt shaped like a llama">
</p>

<h1 align="center">WattLlama</h1>

<p align="center">
  <b>How many watts does your local LLM really burn?</b><br>
  A live power, temperature and token dashboard for Windows PCs running llama.cpp.<br>
  No drivers, no admin rights, no Docker, no npm packages. One small Node.js process.
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4">
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/Node.js-22.13%2B-339933">
  <img alt="llama.cpp" src="https://img.shields.io/badge/llama.cpp-server%20%26%20router-ffd23f">
  <img alt="0 dependencies" src="https://img.shields.io/badge/dependencies-0-2ee6d6">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-a06bff">
</p>

![WattLlama dark theme](docs/screenshot-dark.png)

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
- **What exactly is running?** Every loaded model with its real llama.cpp arguments, and how hot
  everything gets.

## Features

| | |
|---|---|
| ⚡ **Power** | Whole-PC watts (GPU, CPU package, RAM measured; rest + PSU loss estimated), history from 1 hour to 30 days, cumulative energy curve |
| 🦙 **Every model separately** | Router mode with several models (e.g. a chat model on the GPU and a small classifier on the CPU): live state, tok/s, requests, tokens in/out, busy time, energy while busy |
| 🔥 **Heatmap** | Day × hour grid of tokens, energy or busy time for all models or one, 7 / 14 / 30 days |
| 🌡️ **Hardware** | GPU temperature, fan, clocks, VRAM, P-state, PCIe link, *why it is throttled*; CPU load, effective clock, RAM, disk I/O. CPU core temperatures, fans and SSD temperatures via [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) (optional) |
| 🎚️ **GPU power limit** | Optional: set the NVIDIA power limit from the page (UAC-confirmed, safe range) and compare efficiency per limit |
| 📋 **Runs** | One row per generation run: model, duration, requests, tokens, tok/s, Wh, Wh per 1k tokens |
| ⚙️ **Setup at a glance** | llama.cpp arguments per model (secrets masked), [pi](https://github.com/badlogic/pi-mono) agent settings (tools, skills, extensions) if you use it, chosen Windows scheduled tasks with last/next run |
| 🌓 **Light & dark** | Follows Windows, or pick one |
| 🪶 **Featherweight** | Measured: **0.02 % CPU, ~150 MB RAM** in total; generation speed unchanged (54–60 tok/s with and without it) |

<details>
<summary>More screenshots</summary>

![Light theme](docs/screenshot-light.png)
![Hardware and power limit](docs/hardware.png)
![Models with their llama.cpp arguments](docs/models.png)

</details>

## Install

Requirements: Windows 10 (1809+) or 11, [Node.js](https://nodejs.org) 22.13 or newer
(`winget install OpenJS.NodeJS.LTS`). An NVIDIA GPU and llama.cpp are optional; without them you get CPU and system power only.

```powershell
git clone https://github.com/depthark/wattllama
cd wattllama
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer checks what your PC can measure, creates `.env`, registers a scheduled task that
starts WattLlama when you log in (current user, no admin), and opens **http://127.0.0.1:8091**.

Just want to look first? `node server.mjs --demo` serves the page with 14 days of sample history
(in memory, nothing saved).

Uninstall: `.\uninstall.ps1` (keeps your history in `data\`; add `-RemoveData` to delete it).

### Connect llama.cpp

It works with a single `llama-server` and with the router (`--models-dir` / `--models-preset`),
with any number of loaded models. Point it at the server in `.env`:

```ini
DASH_LLAMA_URL=http://127.0.0.1:8080
```

Token counts, best source first:

1. **`DASH_LLAMA_LOG`** = the file llama-server's output is redirected to. Exact, per model, also for
   models that produce no text (classifiers, embeddings).
2. **`--metrics`** on the server. Exact.
3. Otherwise `/slots`. Close, but the last moments of each reply can be missed.

### Phone / other devices

```powershell
.\install.ps1 -AllowLan
```

Serves on your network, adds a firewall rule for private networks only, and sets a random access
token. It prints a link to open once on the phone. Handy because a browser tab on the same PC
uses some VRAM, which matters when the model fills the card.

### CPU temperatures, fans, SSDs

Windows has no driver-free way to read CPU core temperatures. Run
[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor), enable
*Options → Remote Web Server → Run*, and set `DASH_LHM_URL=http://127.0.0.1:8085`. Every temperature
and fan it sees shows up, and CPU temperature joins the history chart.

### GPU power limit

Off by default. With `DASH_ALLOW_POWER_LIMIT=1` the GPU card gets a slider:

- only from the PC itself (not from the network), only from WattLlama's own page;
- only between **60 % of the card's default** and its maximum, inside the range NVIDIA's driver allows;
- Windows asks you in a **UAC prompt** every time;
- it is a power cap, **not an undervolt**: it cannot make the PC unstable, worst case the card is slower;
- it **resets on reboot**.

Then run your usual prompts at a few limits and read the *Efficiency by GPU power limit* table.

## How it measures

| What | Source | Accuracy |
|---|---|---|
| GPU power, temperature, clocks, VRAM, throttle reasons | `nvidia-smi` streaming every 2 s, one process | measured |
| CPU package and RAM power | Windows *Energy Meter* (RAPL) counters where Windows exposes them (most Intel desktop CPUs), read through the PDH API with English counter names, so any Windows display language works | measured |
| CPU load, effective clock, disk I/O, ACPI zone | Windows performance counters | measured |
| Rest of the PC (motherboard, disks, fans) | `DASH_REST_W` (35 W) | estimate |
| Power supply loss | divided by `DASH_PSU_EFF` (0.88) | estimate |
| Monitor | not counted | |
| CPU power on PCs without RAPL counters | from load × `DASH_CPU_MAX_W` | estimate, marked "(est.)" |
| Non-NVIDIA GPUs | add their typical draw to `DASH_REST_W` | estimate |

For exact wall-socket numbers, nothing beats a smart plug with energy metering; WattLlama tells you
*where* the watts go and how much of it the LLM caused.

History lives in `data/power.db` (SQLite, built into Node.js): one row per minute, roughly 5–7 MB a month.

## Compared with popular tools

| | LLM tokens & energy per token | Power history (kWh) | GPU + CPU sensors | Windows, no admin | Setup |
|---|---|---|---|---|---|
| **WattLlama** | ✅ per model, per run | ✅ | ✅ (+ LHM) | ✅ | one script |
| [MSI Afterburner](https://www.msi.com/Landing/afterburner/graphics-cards) | ❌ | ❌ (log file) | ✅ GPU | admin | GUI app |
| [HWiNFO](https://www.hwinfo.com) | ❌ | ❌ (CSV log) | ✅ | admin driver | GUI app |
| [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) | ❌ | ❌ | ✅ | admin driver | GUI app (WattLlama can read it) |
| [nvitop](https://github.com/XuehaiPan/nvitop) / [nvtop](https://github.com/Syllo/nvtop) | ❌ | ❌ | GPU only | nvitop yes / nvtop Linux | terminal |
| [btop](https://github.com/aristocratos/btop) / [Glances](https://github.com/nicolargo/glances) | ❌ | ❌ | ✅ | partly | terminal / web |
| [Beszel](https://github.com/henrygd/beszel) | ❌ | ✅ | ✅ | agent | hub + agent |
| Grafana + exporters | with work | ✅ | ✅ | services | 3+ services |
| LM Studio / llama.cpp web UI | tok/s per message | ❌ | ❌ | ✅ | built in |

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
  file names, pi's `auth.json` and API keys are never read.
- The single optional write action (GPU power limit) is described above: off by default, local
  only, same-origin with a custom header (blocks CSRF), range-checked, UAC-confirmed.
- Crash-safe: an unexpected error is logged and the process restarts; it never touches drivers,
  clocks, fans or voltages.

See [SECURITY.md](SECURITY.md) for reporting.

## Configuration

Everything lives in `.env` (see [.env.example](.env.example)); all settings are optional.

| Setting | Default | |
|---|---|---|
| `DASH_HOST` / `DASH_PORT` | `127.0.0.1` / `8091` | where the page is served |
| `DASH_LLAMA_URL` | `http://127.0.0.1:8080` | llama.cpp server or router; empty = power only |
| `DASH_LLAMA_LOG` | – | llama-server log file, for exact token counts |
| `DASH_LLAMA_API_KEY` | – | if the server uses `--api-key` |
| `DASH_REST_W` / `DASH_PSU_EFF` | `35` / `0.88` | the estimated part |
| `DASH_CPU_MAX_W` | `65` | only used without RAPL counters |
| `DASH_LHM_URL` | – | LibreHardwareMonitor web server |
| `DASH_ALLOW_POWER_LIMIT` | `0` | GPU power limit control |
| `DASH_TOKEN` | – | require a token (set by `-AllowLan`) |
| `DASH_TASKS` | – | scheduled tasks to show, e.g. `Backup*,MyLLM` |
| `DASH_PI_DIR` | `~/.pi/agent` | pi agent settings |

## License

MIT
