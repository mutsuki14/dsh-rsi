#!/usr/bin/env bash
# Offline end-to-end check: installs this checkout into a throwaway dsh profile with
# `dsh plugin add`, points the DeepSeek provider at scripts/mock-deepseek.mjs, and runs
# real `dsh` headless sessions:
#   1. interactive: rsi_submit → isolated Verifier sub-agent → rsi_learn → reconcile → commit
#   2. Phase 1: rsi_explore broad → Curriculum fixtures → practice Actor → Verifier → learning
#      (on the 0.2.0-rc line, rsi_explore must refuse loudly instead)
# Needs Node ^22.19 and network access to npm the first time (for the dsh CLI).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-0.2.1-alpha.2}"
PORT="${PORT:-18093}"
WORK="$(mktemp -d)"
MOCK_PID=""
cleanup() {
  if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

export DSH_HOME="$WORK/dsh-home"
export DEEPSEEK_API_KEY=sk-offline-e2e
export DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT"
export NO_PROXY="127.0.0.1${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1${no_proxy:+,$no_proxy}"

if [[ -n "${DSH:-}" ]]; then
  dsh() { "$DSH" "$@"; }
else
  dsh() { npx -y "@deepseek-ai/dsh@$DSH_VERSION" "$@"; }
fi
legacy=false
[[ "$(dsh --version)" == 0.2.0* ]] && legacy=true

(cd "$REPO" && pnpm run build >/dev/null)
dsh --profile rsi-e2e --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile rsi-e2e add "$REPO" >/dev/null
dsh --profile rsi-e2e --dump-config | grep -q '^# == dsh-rsi' || { echo "dsh-rsi layer missing" >&2; exit 1; }

node "$REPO/scripts/mock-deepseek.mjs" "$WORK/requests.jsonl" "$PORT" &
MOCK_PID=$!
sleep 1

memory_root() { ls -d "$DSH_HOME"/rsi/"$1"-* 2>/dev/null | head -1; }

echo "== interactive verify-and-learn (dsh $(dsh --version))"
mkdir -p "$WORK/ws-task" && printf hello > "$WORK/ws-task/hello.txt"
(cd "$WORK/ws-task" && dsh --profile rsi-e2e "Create hello.txt containing hello")
TASK_MEM="$(memory_root ws-task)"
grep -q '"kind":"task","outcome":"PASS"' "$TASK_MEM/journal.jsonl"
test -f "$TASK_MEM/memory/procedures/greeting-files.md"
test ! -e "$WORK/ws-task/.dsh-rsi"

echo "== Phase 1 broad exploration"
mkdir -p "$WORK/ws-explore"
out="$(cd "$WORK/ws-explore" && dsh --profile rsi-e2e "Explore this shell workspace and improve yourself")"
echo "$out"
if $legacy; then
  grep -q 'Exploration unsupported on this dsh version' <<<"$out"
else
  EXPLORE_MEM="$(memory_root ws-explore)"
  grep -q '"termination": "saturated"' "$EXPLORE_MEM/lineages/e2e-broad/result.json"
  grep -q '"kind":"practice","outcome":"FAIL"' "$EXPLORE_MEM/journal.jsonl"
  test -f "$EXPLORE_MEM/lineages/e2e-broad/wave-001/greet/fixtures/tree/name.txt"
fi

echo "== roles seen by the mock model"
node -e 'const fs=require("fs");const n={};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)){const r=JSON.parse(l).role;n[r]=(n[r]||0)+1}console.log(n)' "$WORK/requests.jsonl"
echo "e2e OK"
