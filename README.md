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
validator-pinned ER routing. Empty `UserLiquidity` can commit-and-undelegate.
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

## Frontend

The Phase 05 frontend uses the selected **Chart First — Game Arena** direction. It always reads live
state: durable configuration on the base layer, delegated routing from the Magic Router,
  and reads the Market, typed oracle payload, USDC balance, and `UserPositions` from the returned ER.
  After the initial snapshot, the chart subscribes directly to that routed ER's oracle account over
  Solana WebSocket `accountSubscribe`; slower snapshots continue to refresh positions and balances
  without overwriting a newer streamed price.
  A deployment can instead configure an authenticated stream proxy. The connected wallet signs the
  proxy challenge once, the short-lived token remains in memory, and the same token is attached to
  its HTTP bootstrap read and websocket subscription. Game transactions still go directly to the
  router-selected ER, matching the binary-prediction client in `magicblock-engine-examples`.
  It uses the official Solana wallet adapter for wallet-signed setup and plays, provisions the user's
  `UserPositions` and eSPL balances on the Market validator, verifies router co-location, and preserves
  a durable nonce/salt intent so an ambiguous ER result is checked instead of blindly retried. The
  current contract still requires the wallet authority for each play; session-key signing needs a
  separate session-aware program instruction and is not emulated in the browser.

The write flow provisions a low-balance, in-memory fee/task-payer keypair on the Market validator.
It can pay ER fees and fund Hydra task creation, but it cannot authorize collateral movement or a
position—the connected wallet still signs every play. Accordingly, `open_position` takes a separate
writable `task_payer`, while the user remains a read-only signer. `delegate_market` and
`delegate_user_liquidity` now both take an explicit validator so every required account is pinned to
the same routed ER.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://127.0.0.1:3000`. The configured Market and oracle must exist on one routed ER; the app
has no synthetic-price or in-memory-position fallback. The live adapter fails closed on a
wrong owner/feed/exponent, partial or unposted verification, stale/future data, excessive confidence,
or cross-ER account mismatch.

```bash
pnpm check
```

For a deterministic end-to-end run, the local harness builds the program, boots a base validator,
an ER, the Query Filtering Service, and Hydra, then uses a real keypair-backed wallet adapter surface
to open winning Up and Down plays, observe both oracle updates over websocket, settle them
automatically, and verify both payouts:

```bash
pnpm test:e2e:local
```

The harness seeds liquidity above the exact protocol minimum because eSPL transfers consume a small
amount before the pool's spendable balance reaches the ER.

The public devnet oracle probe subscribes to MagicBlock's canonical BTC/USD Pyth Lazer feed directly
over the ER websocket and requires multiple monotonically newer updates:

```bash
pnpm test:oracle:devnet
```
