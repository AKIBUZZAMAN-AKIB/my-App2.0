#!/usr/bin/env bash
# Real-provider smoke test (no API key: Kilo free routes + OVHcloud anonymous).
# Usage: tools/real-provider-smoke/run.sh OUT_DIR [scenario...]
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=${1:?out dir}; shift
mkdir -p "$OUT"
PORT=${PORT:-8899}
NAMES=$(python3 "$ROOT/tools/real-provider-smoke/scenarios.py" "$OUT/scenarios")
[ $# -gt 0 ] && NAMES="$*"
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  PORT=$PORT LOG_DIR="$OUT/proxy" CTX_OVERRIDE='{"Qwen2.5-VL-72B-Instruct": 60000}' \
    nohup python3 "$ROOT/tools/real-provider-smoke/proxy.py" > "$OUT/proxy.out" 2>&1 &
  sleep 1
fi
cd "$ROOT/plugins/native-agent/rust/native-agent-ffi"
for n in $NAMES; do
  before=$(wc -l < "$OUT/proxy/requests.jsonl" 2>/dev/null || echo 0)
  SMOKE_PROXY="http://127.0.0.1:$PORT" SMOKE_SCENARIO_FILE="$OUT/scenarios/$n.json" SMOKE_OUT="$OUT/$n" \
    cargo test --lib real_provider_smoke -- --ignored --nocapture > "$OUT/$n.cargo.log" 2>&1
  code=$?
  after=$(wc -l < "$OUT/proxy/requests.jsonl" 2>/dev/null || echo 0)
  echo "{\"scenario\":\"$n\",\"exit\":$code,\"proxy_from\":$before,\"proxy_to\":$after}" >> "$OUT/runs.jsonl"
  echo "$n: exit $code, proxy records $before..$after"
done
