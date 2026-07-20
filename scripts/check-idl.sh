#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=90473101aec64608e0ee159c385928be2a4827ffcd24870c26c6516e97d9bffb
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
