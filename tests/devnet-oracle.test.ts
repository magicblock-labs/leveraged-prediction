import { describe, expect, it } from "vitest";
import { subscribeOraclePrice } from "@/app/lib/live/oracle-stream";

const suite = process.env.LIVE_ORACLE_E2E === "1" ? describe : describe.skip;
const BTC_ORACLE = "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr";
const BTC_FEED_ID = "59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65";
const BTC_ORACLE_ER =
  process.env.LIVE_ORACLE_ER_ENDPOINT ?? "https://devnet-as.magicblock.app";

suite("MagicBlock devnet BTC oracle", () => {
  it("streams fully verified, monotonically newer BTC/USD updates", async () => {
    const updates: Array<{ price: number; slot: bigint; publishTime: number }> = [];
    const errors: unknown[] = [];
    let stop: () => void = () => undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`BTC websocket timed out after ${updates.length} updates: ${errors.map(String).join("; ")}`));
        }, 20_000);

        stop = subscribeOraclePrice(
          {
            erEndpoint: BTC_ORACLE_ER,
            oracleAddress: BTC_ORACLE,
            oracleFeedId: BTC_FEED_ID,
          },
          (update) => {
            updates.push({
              price: update.displayPrice,
              slot: update.postedSlot,
              publishTime: update.publishTime,
            });
            if (updates.length >= 2) {
              clearTimeout(timeout);
              resolve();
            }
          },
          (error) => errors.push(error),
        );
      });
    } finally {
      stop();
    }

    expect(errors).toEqual([]);
    expect(updates).toHaveLength(2);
    expect(updates[0].price).toBeGreaterThan(1_000);
    expect(updates[1].slot).toBeGreaterThan(updates[0].slot);
    expect(updates[1].publishTime).toBeGreaterThanOrEqual(updates[0].publishTime);
  });
});
