# Leveraged Prediction

Anchor program for ten-second directional positions with fixed 1000x price
sensitivity, capped profit/loss, internal LP shares, external eSPL custody, and
Hydra settlement.

One global `ProtocolConfig` pins USDC. Each 116-byte `Market` has a stable
`u16` ID, its own oracle address/feed, vault shares, and risk state. Users
initialize only the delegated state they need:

- `UserPositions`: 452 bytes, up to eight 55-byte market-tagged trades.
- `UserLiquidity`: 348 bytes, up to eight market-tagged LP entries.

Both are user-only base PDAs with a 10-second periodic commit request and
default ER routing. Empty `UserLiquidity` can commit-and-undelegate.
`UserPositions` and Market remain delegated because outstanding Hydra retries
cannot yet be proven exhausted on-chain. There is no LP mint, per-market user
account, shard ID, or per-trade account.

Hydra calls `settle_position`, which transfers every nonzero settlement or
refund to the user token account fixed in the task at open time. If that
destination is unavailable, settlement uses the canonical USDC ATA owned by
`UserPositions`; the user later drains it with `claim_fallback_payout`.

The program expects canonical SPL token accounts materialized on the ER from
external Ephemeral SPL Token custody. Market pool and fee custody are isolated
per Market while every Market uses the ProtocolConfig USDC mint.

```bash
cargo test -p leveraged-prediction --lib --locked
anchor build --ignore-keys
```
