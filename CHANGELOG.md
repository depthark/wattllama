# Changelog

All notable changes to WattLlama. Versions follow [semantic versioning](https://semver.org/);
each release also has notes with upgrade steps on the
[releases page](https://github.com/depthark/wattllama/releases).

## [Unreleased]

## [0.5.0] - 2026-10-24

Asked for on X: does energy per token subtract idle power, and are prefill and generation
reported separately? Now they are.

### Added
- **Wh / 1k tokens above idle**, per model and per run: the energy the model added on top of
  what the PC draws anyway (idle baseline = 20th percentile of whole idle minutes, last 7 days).
  Shown on the model cards, in the runs table, in the report, its CSV and *Share your result*
  (`whPer1kAboveIdle`).
- **Prefill vs generation energy** in the report and its CSV: each model's energy split by the
  time its logged requests spent on the prompt and on generating, per 1k prompt tokens and per
  1k generated tokens. An estimate (both phases assumed to draw the same power); models without
  request timings show –.
- `CHANGELOG.md`.

## [0.4.1] - 2026-10-19

### Changed
- The GPU power-limit slider stops at the card's **default**: it can only lower the limit.
  Above the default needs `DASH_POWER_LIMIT_ABOVE_DEFAULT=1` (Linux:
  `./install.sh --power-limit-above-default`), because more power can trip a weak power supply.

## [0.4.0] - 2026-10-19

### Added
- **Alerts**: GPU / CPU too hot, thermal throttling, VRAM ≥ 99 %, an engine that stops
  answering, a model generating for an hour, daily kWh or cost budgets; on the page, as browser
  notifications, or through Discord, ntfy, Slack or a JSON webhook.
- **Inference details**: per request generation and prefill speed against context depth, time
  to first token, speculative-decoding acceptance, prompt-cache reuse, live context use per slot.
- **Linux power limit** without a password prompt (`./install.sh --power-limit`).

### Security
- `data/` and `.env` readable by you only; read-only database connection for the page; WAL,
  integrity check, versioned migrations, daily backups, retention.
- Token lockout, rate limit, slowloris timeouts; no SQL from request data, fuzzed endpoints,
  prototype-key lookups closed.

### Fixed
- CSV export on Node 22.13 ("statement has been finalized").
- Logs with `\r\r` line endings.

## [0.3.0] - 2026-10-18

### Added
- **Linux**: systemd user service, hwmon sensors, CPU + RAM power through a locked-down RAPL
  helper (`--rapl`), Ollama counts from the journal, systemd timers, NVIDIA power limit via polkit.

### Fixed
- A single `llama-server` showed the full model path, including the user name.
- Windows paths were not cut on Linux; `.env` duplicates were read differently by server and
  installers; empty cost rows without a price; the `/slots` fallback skipped the first request.

## [0.2.0] - 2026-10-18

### Added
- **Ollama and LM Studio** next to llama.cpp, with exact token counts; engine adapters in `engines/`.
- **Report** per day and per model (CSV or PDF), optional electricity cost, *Share your result*,
  AMD / Intel GPUs via LibreHardwareMonitor, CSV export.

## 0.1.0 - 2026-10-18 (not tagged)

- First version: whole-PC watts (GPU, CPU, RAM measured), energy per token per model for
  llama.cpp, day × hour heatmap, GPU power limit, Windows.

[Unreleased]: https://github.com/depthark/wattllama/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/depthark/wattllama/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/depthark/wattllama/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/depthark/wattllama/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/depthark/wattllama/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/depthark/wattllama/releases/tag/v0.2.0
