#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/leveraged-prediction-e2e.XXXXXX")"
STACK_LOG="$RUN_DIR/mb-stack.log"
STACK_PID=""
COMPLETED=0
KEEP_LOCAL_SERVICES="${KEEP_LOCAL_SERVICES:-0}"
LOCAL_STACK_PID_FILE="${LOCAL_STACK_PID_FILE:-}"
LOCAL_HYDRA_PID_FILE="${LOCAL_HYDRA_PID_FILE:-$RUN_DIR/hydra.pid}"
HYDRA_PROGRAM_RPC="${HYDRA_PROGRAM_RPC:-https://devnet-as.magicblock.app}"

cleanup() {
  if [[ "$KEEP_LOCAL_SERVICES" == "1" && "$COMPLETED" == "1" ]]; then
    return
  fi
  if [[ -f "$LOCAL_HYDRA_PID_FILE" ]]; then
    HYDRA_PID="$(<"$LOCAL_HYDRA_PID_FILE")"
    if [[ "$HYDRA_PID" =~ ^[0-9]+$ ]] && kill -0 "$HYDRA_PID" 2>/dev/null; then
      kill "$HYDRA_PID" 2>/dev/null || true
    fi
  fi
  if [[ -n "$STACK_PID" ]] && kill -0 "$STACK_PID" 2>/dev/null; then
    kill "$STACK_PID" 2>/dev/null || true
    wait "$STACK_PID" 2>/dev/null || true
  fi
  if [[ -d "$RUN_DIR" ]]; then
    rm -r -- "$RUN_DIR"
  fi
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
node scripts/dump-loader-v4-program.mjs \
  "$HYDRA_PROGRAM_RPC" \
  Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea \
  "$RUN_DIR/hydra.so"
NO_DNA=1 anchor build --ignore-keys
solana program dump -u devnet \
  KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5 \
  "$RUN_DIR/session_keys.so"

(
  cd "$RUN_DIR"
  exec mb-stack --reset \
    --upgradeable-program AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr \
    "$REPO_ROOT/target/deploy/leveraged_prediction.so" \
    653bMLonrEbTNbSM9g1vH8PJATH1uh6wYNr9SYEJSzsY \
    --bpf-program PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd \
    "$WORKSPACE_ROOT/leveraged-prediction-extras/tests/fixtures/ephemeral-oracle/target/deploy/ephemeral_oracle.so" \
    --bpf-program Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea \
    "$RUN_DIR/hydra.so" \
    --bpf-program KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5 \
    "$RUN_DIR/session_keys.so"
) >"$STACK_LOG" 2>&1 &
STACK_PID=$!
if [[ -n "$LOCAL_STACK_PID_FILE" ]]; then
  printf '%s\n' "$STACK_PID" >"$LOCAL_STACK_PID_FILE"
fi

for _ in {1..60}; do
  if curl -fs -X POST http://127.0.0.1:8899 \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
    break
  fi
  if ! kill -0 "$STACK_PID" 2>/dev/null; then
    cat "$STACK_LOG"
    exit 1
  fi
  sleep 0.5
done

ER_READY=0
for _ in {1..60}; do
  if curl -fs -X POST http://127.0.0.1:7799 \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
    ER_READY=1
    break
  fi
  if ! kill -0 "$STACK_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if [[ "$ER_READY" -ne 1 ]]; then
  cat "$STACK_LOG"
  exit 1
fi

LOCAL_E2E=1 \
KEEP_LOCAL_SERVICES="$KEEP_LOCAL_SERVICES" \
LOCAL_HYDRA_PID_FILE="$LOCAL_HYDRA_PID_FILE" \
HYDRA_CRANKER_BIN="$WORKSPACE_ROOT/hydra/target/debug/hydra-cranker" \
pnpm exec vitest run tests/local-full-flow.test.ts --testTimeout=180000

COMPLETED=1
if [[ "$KEEP_LOCAL_SERVICES" == "1" ]]; then
  printf 'Local protocol ready · stack pid %s · runtime %s\n' "$STACK_PID" "$RUN_DIR"
fi
