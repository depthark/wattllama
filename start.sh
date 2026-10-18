#!/usr/bin/env bash
# Runs WattLlama and restarts it if it ever stops, for systems without a systemd user session
# (install.sh uses a systemd user service when there is one). Output goes to data/wattllama.log.
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$DIR/data"
while true; do
  nice -n 10 node --no-warnings "$DIR/server.mjs" >> "$DIR/data/wattllama.log" 2>&1
  sleep 10
done
