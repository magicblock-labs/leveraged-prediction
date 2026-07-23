#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=f9438b173621035dd424278a2cfb4656bf777ed8046426ff1dab79b6080c1ae8
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
