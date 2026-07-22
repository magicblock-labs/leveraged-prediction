#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=3be40afaf27ba7a51cb08509cf735afcf9faae4ba74db8c8195fec6d8d82e22d
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
