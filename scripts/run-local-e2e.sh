#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ "$REPO_ROOT" == */.worktrees/* ]]; then
  WORKSPACE_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
else
  WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
fi
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/leveraged-prediction-e2e.XXXXXX")"
STACK_LOG="$RUN_DIR/mb-stack.log"
STACK_PID=""
COMPLETED=0
KEEP_LOCAL_SERVICES="${KEEP_LOCAL_SERVICES:-0}"
LOCAL_STACK_PID_FILE="${LOCAL_STACK_PID_FILE:-}"

cleanup() {
  if [[ "$KEEP_LOCAL_SERVICES" == "1" && "$COMPLETED" == "1" ]]; then
    return
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
pnpm exec vitest run tests/local-full-flow.test.ts --testTimeout=180000

if [[ -n "${DATABASE_URL:-}" ]]; then
  NO_DNA=1 cargo run \
    --manifest-path services/indexer/Cargo.toml \
    -p leveraged-prediction-indexer \
    --locked -- \
    migrate \
    --database-url "$DATABASE_URL"
  NO_DNA=1 cargo run \
    --manifest-path services/indexer/Cargo.toml \
    -p leveraged-prediction-indexer \
    --locked -- \
    ingest-recent \
    --database-url "$DATABASE_URL" \
    --rpc-endpoint http://127.0.0.1:7799 \
    --network localnet \
    --layer er \
    --limit 100 \
    --v2-min-slot 0
  projected_positions="$(
    psql "$DATABASE_URL" -Atc \
      "SELECT count(*) FROM indexer.positions WHERE network = 'localnet' AND lifecycle_status IN ('settled', 'refunded')"
  )"
  if [[ "$projected_positions" -lt 2 ]]; then
    echo "expected two terminal local indexer positions, found $projected_positions" >&2
    exit 1
  fi
fi

COMPLETED=1
if [[ "$KEEP_LOCAL_SERVICES" == "1" ]]; then
  printf 'Local protocol ready · stack pid %s · runtime %s\n' "$STACK_PID" "$RUN_DIR"
fi
