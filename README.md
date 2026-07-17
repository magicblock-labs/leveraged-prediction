# Leveraged Prediction

Anchor program for ten-second directional positions with fixed 1000x price
sensitivity, capped profit/loss, internal LP shares, external eSPL custody, and
Hydra settlement.

The contract uses one 476-byte `UserPosition` per user, holding up to eight
53-byte positions, including each Hydra task salt. `Market` is 82 bytes
including its discriminator. Product parameters are fixed in the program.

Hydra calls `settle_position`, which transfers every nonzero settlement or
refund directly to the user token account fixed in the task at open time.

```bash
cargo test -p leveraged-prediction --lib --locked
anchor build --ignore-keys
```
