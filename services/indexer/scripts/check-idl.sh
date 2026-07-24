#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
snapshot="$repo_root/services/indexer/idl/leveraged_prediction.json"
generated="$repo_root/target/idl/leveraged_prediction.json"
decoder="$repo_root/services/indexer/crates/decoder/src"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/leveraged-prediction-idl.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

cd "$repo_root"
NO_DNA=1 anchor build --ignore-keys

jq -S . "$snapshot" >"$scratch/snapshot.json"
jq -S . "$generated" >"$scratch/generated.json"
if ! cmp -s "$scratch/snapshot.json" "$scratch/generated.json"; then
  diff -u "$scratch/snapshot.json" "$scratch/generated.json" || true
  echo "IDL snapshot drifted; refresh services/indexer/idl and regenerate the decoder" >&2
  exit 1
fi

npx --yes @sevenlabs-hq/carbon-cli@0.12.0 parse \
  -i "$snapshot" \
  -o "$scratch/decoder" \
  -c \
  -s anchor \
  --program-id AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr \
  --with-postgres false \
  --with-graphql false \
  --with-serde true >/dev/null

NO_DNA=1 cargo fmt --manifest-path "$scratch/decoder/Cargo.toml" --all
diff -ru "$decoder" "$scratch/decoder/src"
echo "IDL snapshot and Carbon decoder are current"
