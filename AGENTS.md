# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working on WattLlama. Read it fully before
changing anything; [CONTRIBUTING.md](CONTRIBUTING.md) has the engine adapter interface in detail.

## What this is

A local dashboard that connects a PC's power draw to the tokens its local LLMs generate: whole-PC
watts (GPU, CPU and RAM measured, the rest estimated), per-minute history in SQLite, and per model
and per run tokens, busy time, energy and Wh per 1,000 tokens. Windows and Linux, llama.cpp,
Ollama and LM Studio. One Node.js process, no npm dependencies, served on 127.0.0.1:8091.

## Layout

| Path | What it does |
|---|---|
| `db.mjs` | Opens SQLite safely: permissions, WAL and safe pragmas, integrity check, `MIGRATIONS` (versioned with `user_version`), the read-only connection `rdb`, daily backup and retention |
| `alerts.mjs` | Alert rules (held for a minute, cooldown, resolve), the `events` table, the optional webhook (Discord / ntfy / Slack / JSON) |
| `server.mjs` | Everything server-side in one file, in this order: config (`.env`), child samplers (`stream()`), nvidia-smi, CPU sampler via `platform/`, LibreHardwareMonitor / native sensors, engine polling, the per-minute bucket and SQLite writes, queries (series, heatmap, summary, report, efficiency, share, CSV), setup info (engines, pi, scheduled tasks), HTTP with all security checks, crash handling |
| `platform/windows.mjs`, `platform/linux.mjs` | All OS differences: CPU / RAM / disk sampling, sensors, OS name, scheduled tasks, the power-limit command. `server.mjs` imports one of them at start |
| `sampler.ps1`, `tasks.ps1` | Windows helpers: one long-running PowerShell process reading PDH counters (English counter names, so any display language works); Task Scheduler listing on demand |
| `platform/power-limit.sh` | Optional Linux root helper (`install.sh --power-limit`, one sudoers rule): sets one GPU's power limit, re-checks the range, numbers only |
| `platform/rapl-helper.sh`, `platform/wattllama-rapl.service` | Optional Linux root helper (`install.sh --rapl`) that publishes coarse RAPL watts in `/run/wattllama/rapl` |
| `engines/*.mjs` | One adapter per inference engine; `engines/index.mjs` lists them; `engines/common.mjs` has shared helpers (log tail, llama-server log parser, `/slots` poller, argument masking) |
| `public/` | The page: plain HTML, CSS, JavaScript, no build step. `app.js` polls `/api/*` and draws canvas charts |
| `install.ps1`, `uninstall.ps1`, `start.ps1` | Windows: scheduled task at logon, `start.ps1` restarts the server if it stops |
| `install.sh`, `uninstall.sh`, `start.sh` | Linux: systemd user service; `start.sh` only where there is no systemd user session |
| `tests/` | `node:test` suites, fake engines (`helpers.mjs`, `fake-lms.mjs`), fake `/proc` and `/sys` trees |
| `data/` | `power.db` and the Windows log. Git-ignored, like `.env` |

## How the numbers are made

1. Every `DASH_INTERVAL_MS` (2 s) `tick()` polls the engines, takes the latest GPU (nvidia-smi
   stream) and CPU sample, computes whole-PC watts as `(GPU + CPU package + RAM + DASH_REST_W) /
   DASH_PSU_EFF`, and adds `watts × dt` to the current minute's bucket.
2. A model is **busy** while its engine reports `processing`, or, for engines that only report
   finished requests (LM Studio), for the exact `busySec` they report afterwards. Busy seconds and
   the whole-PC energy during them go to that model's minute row (`mm`) and its open **run**. A
   run closes after 15 s without work, so an agent's tool-call pauses stay one run.
3. Tokens arrive through `addTokens(model, generated, prompt, requests)` from the adapters and land
   in the same minute and run. Adapters that see whole requests (llama.cpp and Ollama logs via
   `requestAssembler`, LM Studio stats) also call `addRequest()`: one `requests` row per request with
   prefill / generation tokens and times, context depth, draft acceptance and cached prompt tokens.
4. Every 10 s and at each new minute the bucket is written (`INSERT OR REPLACE`); a restart within
   a minute resumes that minute's rows (`resumeBucket`). `dt` is capped at 10 s, so a sleeping PC
   does not count as running.

Tables: `m` (whole PC per minute), `mm` (per model per minute), `runs`, `events` (alerts),
`requests` (llama.cpp per request). Schema changes go into `MIGRATIONS` in `db.mjs` as a new entry
(never edit an old one, never drop or change a column). Writes use `db` (the server only);
everything the page asks for goes through `rdb`, which is read-only twice over (open flag and
`query_only`). Keep it that way when adding a query.

## Rules that must not be broken

**Security.** The page is read-only and local.
- Only GET/HEAD, plus the single POST `/api/gpu/power-limit`, which stays: off by default
  (`DASH_ALLOW_POWER_LIMIT`), loopback only, `Origin` equal to the host plus the `x-wattllama`
  header and a JSON body (CSRF), integers range-checked by `powerRange()` (power.mjs): 60 % of the
  default up to the default, above it only with DASH_POWER_LIMIT_ABOVE_DEFAULT=1, one change at a time, confirmed by the OS (UAC / polkit). Do not add other write endpoints.
- Static files come from the fixed `STATIC` map; no path is ever taken from the URL. SQL table
  names, ranges and periods come from fixed lists; user input is only ever a bound parameter.
- `hostAllowed()` (DNS rebinding) and `tokenOk()` (`DASH_TOKEN`, constant-time compare) run before
  anything else. Keep the security headers and the CSP (`script-src 'self'`, no inline script).
- `data/` and `.env` stay private to the user (0700 / 0600, or the ACL from install.ps1); the
  database is never served, and its backups live in `data/backup/` with the same protection.
- Nothing private reaches the page or the database: `argPairs()` masks secret-looking flags and
  cuts paths to file names on any OS (`baseName()`, not `path.basename`, which keeps Windows paths
  whole on Linux); model ids must not contain folders; pi's `auth.json` and API keys are never read;
  prompts and replies passing through an engine's log stream are matched and dropped, never stored
  or logged. Every value from an engine or a sensor goes through `esc()` before it becomes HTML.
- Nothing runs as admin or root. The two Linux helpers are the only root parts and must stay
  minimal: the RAPL helper under its locked-down unit (CI fails if `systemd-analyze security`
  exceeds 1.5), the power-limit helper behind a sudoers rule for exactly that file, validating its
  two whole-number arguments and the range itself.
- Lookup tables keyed by request input are created with `fixed()` (no prototype), so keys like
  `constructor` or `__proto__` never pass a check. Wrong tokens are rate-limited (lockout).
- SQLite iterators must not stay open across `await` (Node 22.13 invalidates them when other
  queries run): read in short pages, as the CSV export does.
- Nothing is sent anywhere, except alerts to `DASH_ALERT_WEBHOOK` when the user sets one: https (or
  http to a private address), no redirects, 5 s timeout, at most 20 an hour, numbers and model names
  only, Discord mentions disabled. The URL is a secret: `settings()` exposes only its format, logs
  only the host. *Share your result* only builds a GitHub URL the user opens.

**Performance.** It is a monitor: generation speed must not change (measured: 54–60 tok/s with
and without it on the author's PC).
- No process spawned per poll. Long-running children only (`nvidia-smi -lms`, `sampler.ps1`,
  `lms log stream`, `journalctl -f`); anything expensive (PowerShell, `/api/show`) runs on change
  or is cached (`cached()`).
- An engine that does not answer is asked again every 10 s only.
- Never call llama.cpp's router about a model that is not loaded (`/slots?model=X` loads it).
- The page polls only while visible: 2 s live, 30 s history, 60 s setup.

**Robustness.** A broken sensor or engine shows "–" and is logged; it never stops the tick loop.
`uncaughtException` flushes and exits, and the supervisor (`start.ps1`, systemd, `start.sh`)
restarts after 10 s.

**Dependencies.** None. Node.js built-ins (`node:sqlite` needs 22.13+) and the OS's own tools.

## Verify a change

```bash
node --test tests/*.test.mjs        # Linux-only tests are skipped on Windows (":" in sysfs names)
node server.mjs --demo              # 14 days of sample history in memory, http://127.0.0.1:8091
```

- Next to an installed copy: `DASH_PORT=8092 DASH_DATA_DIR=<temp dir> node server.mjs`.
- Screenshots: `?theme=light|dark`; for public ones set `DASH_PI_DIR` to a missing folder and
  `DASH_TASKS=` so no personal setup shows.
- Behaviour against a real engine beats a mock: the adapters were each checked live (llama.cpp,
  Ollama 0.40.6, LM Studio / llmster 0.0.25) by comparing the engine's own usage numbers with what
  WattLlama counted. Do the same when touching an adapter.
- CI (`.github/workflows/ci.yml`) runs Windows and Linux on Node 22.13 / 22 / 24: syntax, shellcheck,
  the RAPL unit hardening, all tests, and `install.sh → page → uninstall.sh`.

## Known limits (do not "fix" by guessing)

- LM Studio reports a prediction only when it ends: busy time is exact but credited afterwards; the
  page shows it idle while it generates.
- `/slots` counts are approximate (the counter resets when a request ends); logs and `/metrics` are
  exact. Prompt tokens are the ones actually computed; cache hits are not counted.
- Linux power limit via `pkexec` is unconfirmed from the background service (issue #5).
- WSL has no RAPL or hwmon; Linux sensor code is tested against recorded sysfs trees.

## Conventions

- Plain modern JavaScript (ES modules), two-space indent, short comments that say *why*.
- UI text in English. Units: W, Wh / kWh; money only when the user sets a price.
- Small commits that explain why; no force-push or history rewriting on `main`.
- A user-visible change updates the README (and `.env.example` for settings) in the same commit.
- A user-visible change also adds a line under `## [Unreleased]` in `CHANGELOG.md`. A release
  moves those lines under a new `## [x.y.z] - date` heading, bumps `package.json`, tags `vx.y.z`
  and uses the same text for the GitHub release notes (plus upgrade steps).
