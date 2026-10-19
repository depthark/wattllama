#!/bin/bash
# WattLlama power-limit helper (Linux, optional: install.sh --power-limit).
#
# Setting an NVIDIA power limit needs root. Instead of running anything else as root, a sudoers
# rule lets your user run exactly this root-owned file without a password, and it does one
# thing: set one GPU's power limit, checked here again (the page checked it already) to lie
# between 60 % of the card's default and its maximum. A power cap only slows the card down;
# it cannot make the system unstable, and it resets at reboot.
#
#   power-limit <gpu index> <watts>
set -euo pipefail

NVSMI=/usr/bin/nvidia-smi                       # install.sh writes the real, root-owned path here
# Tests may point to a fake nvidia-smi, but never when running as root (sudo resets the
# environment anyway).
if [ "$(id -u)" -ne 0 ] && [ -n "${WATTLLAMA_NVSMI:-}" ]; then NVSMI=$WATTLLAMA_NVSMI; fi

if [ $# -ne 2 ] || ! [[ $1 =~ ^[0-9]{1,2}$ ]] || ! [[ $2 =~ ^[0-9]{1,4}$ ]]; then
  echo "usage: power-limit <gpu index> <watts> (whole numbers)" >&2
  exit 2
fi
gpu=$1 watts=$2

IFS=', ' read -r def min max < <("$NVSMI" -i "$gpu" --query-gpu=power.default_limit,power.min_limit,power.max_limit --format=csv,noheader,nounits)
for v in "$def" "$min" "$max"; do
  [[ $v =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "this GPU reports no power limits" >&2; exit 3; }
done
ceil() { local i=${1%.*} f=${1#*.}; if [ "$1" != "$i" ] && [ "$((10#${f:-0}))" -gt 0 ]; then echo $((i + 1)); else echo "$i"; fi; }
d=$(ceil "$def") lo=$(ceil "$min") hi=${max%.*}
steps=$(( (d * 60 + 499) / 500 ))               # 60 % of the default in 5 W steps, rounded up
floor=$(( steps * 5 ))
[ "$floor" -lt "$lo" ] && floor=$lo
if [ "$watts" -lt "$floor" ] || [ "$watts" -gt "$hi" ]; then
  echo "limit must be $floor-$hi W" >&2
  exit 3
fi
exec "$NVSMI" -i "$gpu" -pl "$watts"
