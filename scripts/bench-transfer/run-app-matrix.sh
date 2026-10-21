#!/bin/zsh
# Real-app comparison: for each network profile and app version, start a fresh
# app per iteration and record probe-guest RESULT lines into reports/.
# Usage: scripts/bench-transfer/run-app-matrix.sh <media-file> <iterations> <old-dir> <new-dir> [label-suffix] [profiles...]
set -u
media=$1; iterations=$2; old=$3; new=$4; suffix=${5:-}; only=(${@:6})
repo=${0:A:h:h:h}
profiles=(
  "A --rate-mbps=100 --rtt-ms=20 --queue-ms=50"
  "B --rate-mbps=30 --rtt-ms=80 --queue-ms=80 --loss=0.001"
  "C --rate-mbps=15 --rtt-ms=50 --queue-ms=100 --loss=0.01"
)
for profile in $profiles; do
  set -- ${=profile}; name=$1; shift
  if (( ${#only} > 0 )) && (( ! ${only[(Ie)$name]} )); then continue; fi
  for i in $(seq 1 $iterations); do
    for pair in "old $old" "new $new"; do
      set -- ${=pair} "$@"; label=$1; dir=$2; shift 2
      out=$repo/reports/e2e-app-$name-$label$suffix.jsonl
      echo "=== profile $name $label iteration $i"
      PROBE_QUIET=1 E2E_SCRIPT=$repo/scripts/bench-transfer/probe-guest.mjs \
        node $repo/scripts/bench-transfer/run-app-e2e.mjs $dir $media 150 $out "$@" 2>&1 | grep -E "RESULT|netem|rror" | head -3
    done
  done
done
