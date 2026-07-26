#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=b62351025d33c95c3a02d13a8bfbeb68347df30ded2fa93a627f80540720c434
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
