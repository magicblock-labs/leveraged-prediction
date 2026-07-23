#!/bin/sh
set -eu

idl=${1:-target/idl/leveraged_prediction.json}
expected=ba77db8f4fe9530ff28d7b1397d08901076843482ec1b795e1d6b994b50af8c4
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
