#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=69f379140587cd87ef99e35362091605701e7205f457f7535b7be0cc0cb4ba2f
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
