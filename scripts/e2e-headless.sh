#!/usr/bin/env bash
# Offline end-to-end check: installs this checkout into a throwaway dsh profile with
# `dsh plugin add`, points the DeepSeek provider at scripts/mock-deepseek.mjs, and runs
# two real `dsh` headless sessions:
#   1. interactive: rsi_submit → Verifier sub-agent → rsi_learn → reconcile → commit
#   2. Phase 1: rsi_explore broad → Curriculum → practice Actor → Verifier → learning
# Needs Node ^22.19 and network access to npm the first time (for the dsh CLI).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-0.2.1-alpha.2}"
PORT="${PORT:-18093}"
WORK="$(mktemp -d)"
trap 'kill "${MOCK_PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

export DSH_HOME="$WORK/dsh-home"
export DEEPSEEK_API_KEY=sk-offline-e2e
export DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT"
export NO_PROXY="127.0.0.1${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1${no_proxy:+,$no_proxy}"

if [[ -n "${DSH:-}" ]]; then
  dsh() { "$DSH" "$@"; }
else
  dsh() { npx -y "@deepseek-ai/dsh@$DSH_VERSION" "$@"; }
fi

(cd "$REPO" && pnpm run build >/dev/null)
dsh --profile rsi-e2e --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile rsi-e2e add "$REPO" >/dev/null
dsh --profile rsi-e2e --dump-config | grep -q '^# == dsh-rsi' || { echo "dsh-rsi layer missing" >&2; exit 1; }

node "$REPO/scripts/mock-deepseek.mjs" "$WORK/requests.jsonl" "$PORT" &
MOCK_PID=$!
sleep 1

echo "== interactive verify-and-learn"
mkdir -p "$WORK/ws-task" && printf hello > "$WORK/ws-task/hello.txt"
(cd "$WORK/ws-task" && dsh --profile rsi-e2e "Create hello.txt containing hello")
grep -q '"kind":"task","outcome":"PASS"' "$WORK/ws-task/.dsh-rsi/journal.jsonl"
test -f "$WORK/ws-task/.dsh-rsi/memory/procedures/greeting-files.md"

echo "== Phase 1 broad exploration"
mkdir -p "$WORK/ws-explore"
(cd "$WORK/ws-explore" && dsh --profile rsi-e2e "Explore this shell workspace and improve yourself")
grep -q '"termination": "saturated"' "$WORK/ws-explore/.dsh-rsi/lineages/e2e-broad/result.json"
grep -q '"kind":"practice","outcome":"FAIL"' "$WORK/ws-explore/.dsh-rsi/journal.jsonl"

echo "== roles seen by the mock model"
node -e 'const fs=require("fs");const n={};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)){const r=JSON.parse(l).role;n[r]=(n[r]||0)+1}console.log(n)' "$WORK/requests.jsonl"
echo "e2e OK"
