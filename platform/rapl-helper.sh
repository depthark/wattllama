#!/bin/bash
# WattLlama RAPL helper (Linux, optional: install.sh --rapl).
#
# Since Linux 5.10 the CPU energy counters (/sys/class/powercap/intel-rapl*/energy_uj) are
# readable by root only, because reading them thousands of times a second leaks secrets
# through power side channels (CVE-2020-8694, "Platypus"). This helper runs as root under a
# locked-down systemd unit and publishes only a 2-second average, rounded to 0.1 W, in
# /run/wattllama/rapl ("packageW dramW epochSeconds"), which is far too coarse for that attack
# and all WattLlama needs. It reads sysfs and writes that one file; nothing else.
set -u

BASE=${WATTLLAMA_POWERCAP:-/sys/class/powercap}   # overridable for tests only
OUT=${WATTLLAMA_RAPL_OUT:-/run/wattllama/rapl}
INTERVAL=${WATTLLAMA_RAPL_INTERVAL:-2}

pkg=() dram=()
for z in "$BASE"/intel-rapl:*; do
  [ -r "$z/energy_uj" ] || continue
  name=$(cat "$z/name" 2>/dev/null) || continue
  case "${z##*/}" in
    intel-rapl:*:*) [ "$name" = dram ] && dram+=("$z") ;;
    *) case "$name" in package*) pkg+=("$z") ;; esac ;;
  esac
done
if [ ${#pkg[@]} -eq 0 ]; then
  echo "WattLlama RAPL helper: no RAPL package counters on this machine, nothing to do." >&2
  exit 0
fi

declare -A prev maxr
for z in "${pkg[@]}" "${dram[@]}"; do
  read -r "maxr[$z]" < "$z/max_energy_range_uj" 2>/dev/null || maxr[$z]=0
  read -r "prev[$z]" < "$z/energy_uj"
done

# µJ consumed since the last reading, summed over zones, counter wrap-around handled.
# Result in $DELTA, not echoed: a $(...) subshell would lose the updated prev[] values.
delta() {
  local z e d
  DELTA=0
  for z in "$@"; do
    read -r e < "$z/energy_uj" || continue
    d=$((e - prev[$z]))
    if [ "$d" -lt 0 ]; then d=$((d + maxr[$z])); fi
    prev[$z]=$e
    DELTA=$((DELTA + d))
  done
}

t0=${EPOCHREALTIME/./}
while sleep "$INTERVAL"; do
  t=${EPOCHREALTIME/./}
  dt=$((t - t0)); t0=$t
  [ "$dt" -gt 0 ] || continue
  delta "${pkg[@]}"; p=$DELTA
  d=0
  if [ ${#dram[@]} -gt 0 ]; then delta "${dram[@]}"; d=$DELTA; fi
  pw=$((p * 10 / dt)); dw=$((d * 10 / dt))           # µJ / µs = W, in tenths
  printf '%d.%d %d.%d %d\n' $((pw / 10)) $((pw % 10)) $((dw / 10)) $((dw % 10)) "${t:0:${#t}-6}" > "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT"
done
