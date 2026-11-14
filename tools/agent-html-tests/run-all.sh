#!/usr/bin/env bash
# Runs every agent.html UI check file and writes each one's output to $OUT/<name>.txt.
# Usage: OUT=/home/sprite/testout/final tools/agent-html-tests/run-all.sh [names...]
set -u
cd "$(dirname "$0")/../.."
OUT=${OUT:-/home/sprite/testout/all}
export URL_=${URL_:-file://$PWD/www/agent.html}
mkdir -p "$OUT"
NAMES=("$@")
[ ${#NAMES[@]} -eq 0 ] && NAMES=(subagents s1 files feat ui2 v2 r3 vault render genui folders tools)
fail=0
for n in "${NAMES[@]}"; do
  SHOT=${SHOT:-0} timeout 1500 node "tools/agent-html-tests/$n.js" > "$OUT/$n.txt" 2>&1
  code=$?
  line=$(grep -E "passed" "$OUT/$n.txt" | tail -1)
  echo "$n: exit $code :: ${line:-no summary}"
  [ $code -ne 0 ] && fail=1
done
exit $fail
