#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=02c462c0d5523ed6244a9bd8c495c95c0c9fe2c6efaef6e8a34cb5cb566c108b
actual=$(
  LC_ALL=C LANG=C jq -cS '{instructions,accounts,events,types,errors}' "$idl" |
    LC_ALL=C LANG=C shasum -a 256 |
    awk '{print $1}'
)

if [ "$actual" != "$expected" ]; then
  printf 'IDL contract mismatch: expected %s, got %s\n' "$expected" "$actual" >&2
  exit 1
fi

printf 'IDL contract verified: %s\n' "$actual"
