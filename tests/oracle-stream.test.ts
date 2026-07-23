import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@/app/lib/domain";
import { ORACLE_PROGRAM_ID } from "@/app/lib/live/config";
import { accountDiscriminator } from "@/app/lib/live/decode";
import {
  appendOraclePrice,
  applyOracleStreamUpdate,
  mergeOraclePriceHistory,
  subscribeOraclePrice,
  type OracleStreamConnection,
} from "@/app/lib/live/oracle-stream";

const FEED_ID = Buffer.alloc(32, 7);

function priceUpdate(price: bigint, publishTime: number, postedSlot: bigint): Buffer {
  const data = Buffer.alloc(133);
  accountDiscriminator("PriceUpdateV2").copy(data);
  data.writeUInt8(1, 40);
  FEED_ID.copy(data, 41);
  data.writeBigInt64LE(price, 73);
  data.writeBigUInt64LE(1_000n, 81);
  data.writeInt32LE(8, 89);
  data.writeBigInt64LE(BigInt(publishTime), 93);
  data.writeBigInt64LE(BigInt(publishTime - 1), 101);
  data.writeBigInt64LE(price, 109);
  data.writeBigUInt64LE(1_000n, 117);
  data.writeBigUInt64LE(postedSlot, 125);
  return data;
}

function account(data: Buffer, owner = ORACLE_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

class FakeConnection implements OracleStreamConnection {
  callback: ((value: AccountInfo<Buffer>) => void) | null = null;
  removed: number[] = [];

  constructor(private readonly initial: AccountInfo<Buffer> | null) {}

  async getAccountInfo(): Promise<AccountInfo<Buffer> | null> {
    return this.initial;
  }

  onAccountChange(
    _address: PublicKey,
    callback: (value: AccountInfo<Buffer>) => void,
  ): number {
    this.callback = callback;
    return 17;
  }

  async removeAccountChangeListener(subscriptionId: number): Promise<void> {
    this.removed.push(subscriptionId);
  }
}

afterEach(() => vi.useRealTimers());

describe("routed ER oracle websocket", () => {
  it("emits verified, monotonically posted prices and removes the listener", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(101_000));
    const connection = new FakeConnection(
      account(priceUpdate(11_864_212_000_000n, 100, 99n)),
    );
    const updates: Array<{ displayPrice: number; postedSlot: bigint }> = [];
    const errors: unknown[] = [];
    const unsubscribe = subscribeOraclePrice(
      {
        erEndpoint: "https://devnet-as.magicblock.app",
        oracleAddress: PublicKey.unique().toBase58(),
        oracleFeedId: FEED_ID.toString("hex"),
      },
      (update) => updates.push(update),
      (error) => errors.push(error),
      connection,
    );

    await Promise.resolve();
    expect(updates.map(({ displayPrice, postedSlot }) => ({ displayPrice, postedSlot }))).toEqual([
      { displayPrice: 118_642.12, postedSlot: 99n },
    ]);

    connection.callback?.(account(priceUpdate(11_864_300_000_000n, 101, 100n)));
    connection.callback?.(account(priceUpdate(11_000_000_000_000n, 101, 99n)));
    expect(updates.map(({ displayPrice, postedSlot }) => ({ displayPrice, postedSlot }))).toEqual([
      { displayPrice: 118_642.12, postedSlot: 99n },
      { displayPrice: 118_643, postedSlot: 100n },
    ]);
    expect(errors).toEqual([]);

    unsubscribe();
    await Promise.resolve();
    expect(connection.removed).toEqual([17]);
  });

  it("rejects websocket data from the wrong account owner", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(101_000));
    const connection = new FakeConnection(null);
    const errors: unknown[] = [];
    subscribeOraclePrice(
      {
        erEndpoint: "https://devnet-as.magicblock.app",
        oracleAddress: PublicKey.unique().toBase58(),
        oracleFeedId: FEED_ID.toString("hex"),
      },
      () => undefined,
      (error) => errors.push(error),
      connection,
    );

    connection.callback?.(
      account(priceUpdate(11_864_212_000_000n, 100, 99n), PublicKey.unique()),
    );
    expect(errors.some((error) => String(error).includes("wrong owner"))).toBe(true);
  });

  it("appends websocket samples to the chart and marks the stream live", () => {
    const snapshot: MarketSnapshot = {
      mode: "live",
      marketId: 1,
      marketLabel: "BTC / USD",
      gameLabel: "BTC PRICE RUSH",
      currentPrice: 100,
      priceExponent: 8,
      priceHistory: [{ price: 100, timestamp: 100_000 }],
      feedHealth: "delayed",
      feedAgeSeconds: 3,
      marketMode: "open",
      activePositions: 0,
      maxPositions: 8,
      walletAddress: null,
      walletBalanceUsd: null,
      fallbackClaimableUsd: 0,
      plays: [{
        id: "1-1",
        marketId: 1,
        direction: "up",
        collateralUsd: 10,
        entryPrice: 100,
        openedAt: 100_000,
        expiresAt: 110_000,
        refundAt: 120_000,
        status: "active",
        priceMovePercent: 0,
        liveProfitUsd: 0,
      }],
      capturedAt: 100_000,
    };
    const next = applyOracleStreamUpdate(snapshot, {
      displayPrice: 101,
      rawPrice: 10_100_000_000n,
      ageSeconds: 0.2,
      publishTime: 101,
      postedSlot: 10n,
      receivedAt: 101_200,
    });

    expect(next.currentPrice).toBe(101);
    expect(next.priceHistory.at(-1)).toEqual({ price: 101, timestamp: 101_200 });
    expect(next.plays[0].priceMovePercent).toBe(1);
    expect(next.plays[0].liveProfitUsd).toBe(45);
    expect(next.feedHealth).toBe("live");
    expect(next.notice).toMatch(/websocket connected/);
  });

  it("retains forty-five seconds of a high-frequency price stream", () => {
    const startedAt = 1_000_000;
    let history: MarketSnapshot["priceHistory"] = [];
    for (let index = 0; index <= 1_000; index += 1) {
      history = appendOraclePrice(history, {
        displayPrice: 100 + index / 10_000,
        receivedAt: startedAt + index * 50,
      });
    }

    expect(history.length).toBeGreaterThan(400);
    expect(history.length).toBeLessThanOrEqual(452);
    expect(history.at(-1)?.timestamp).toBe(startedAt + 50_000);
    expect(
      history.at(-1)!.timestamp - history[0].timestamp,
    ).toBeGreaterThanOrEqual(44_900);
  });

  it("merges sparse snapshot samples without replacing browser history", () => {
    const current = [
      { price: 100, timestamp: 100_000 },
      { price: 101, timestamp: 110_000 },
      { price: 102, timestamp: 120_000 },
    ];
    const incoming = [{ price: 103, timestamp: 130_000 }];

    expect(mergeOraclePriceHistory(current, incoming, 130_000)).toEqual([
      ...current,
      ...incoming,
    ]);
  });
});
