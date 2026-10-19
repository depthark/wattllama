# Security

WattLlama is a local, read-only monitor. The design is described in the README's
[Security](README.md#security) section.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → *Report a vulnerability*)
instead of a public issue. Include the OS and version, the WattLlama commit and the steps.

The only parts that run with elevated rights are two optional Linux helpers: the RAPL helper
(`platform/rapl-helper.sh` under `platform/wattllama-rapl.service`, `install.sh --rapl`) and the
power-limit helper (`platform/power-limit.sh` with one sudoers rule, `install.sh --power-limit`).
Reports about them are especially welcome.
