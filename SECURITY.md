# Security

WattLlama is a local, read-only monitor. The design is described in the README's
[Security](README.md#security) section.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → *Report a vulnerability*)
instead of a public issue. Include the OS and version, the WattLlama commit and the steps.

The only part that runs with elevated rights is the optional Linux RAPL helper
(`platform/rapl-helper.sh` under `platform/wattllama-rapl.service`, installed by `install.sh --rapl`).
Reports about it are especially welcome.
