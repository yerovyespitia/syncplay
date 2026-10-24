#!/bin/zsh
# Real-app comparison for magnet rooms: for each magnet and app version, start a
# fresh app per iteration and append probe-torrent RESULT lines to reports/.
# Usage: scripts/bench-torrent/run-app-matrix.sh <iterations> <old-dir> <new-dir> <name=magnet-file>...
set -u
iterations=$1; old=$2; new=$3; shift 3
repo=${0:A:h:h:h}
for source in "$@"; do
  name=${source%%=*}; magnet=$(cat ${source#*=})
  for i in $(seq 1 $iterations); do
    # Alternate which version goes first to cancel out swarm drift over time.
    order=("old $old" "new $new"); (( i % 2 == 0 )) && order=("new $new" "old $old")
    for pair in $order; do
      set -- ${=pair}; label=$1; dir=$2
      echo "=== $name $label iteration $i"
      PROBE_QUIET=1 PROBE_STOP_AFTER_SEEK_MS=90000 E2E_SCRIPT=$repo/scripts/bench-torrent/probe-torrent.mjs \
        node $repo/scripts/bench-transfer/run-app-e2e.mjs $dir "$magnet" 240 $repo/reports/torrent-app-$name-$label.jsonl 2>&1 | grep -E "RESULT|rror|Timed out|failed" | head -3 || echo "no result (run failed)"
    done
  done
done
