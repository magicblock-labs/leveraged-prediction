import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@/app/lib/domain";
import { accountDiscriminator } from "@/app/lib/live/decode";
import {
  applyMarketStreamUpdate,
  applyPositionStreamUpdate,
  subscribeUserPositions,
  type PositionStreamConnection,
} from "@/app/lib/live/position-stream";

function positionsAccount(
  owner: PublicKey,
  positions: Array<{
    marketId: number;
    nonce: number;
    collateral: number;
    entryPrice: bigint;
    expiresAt: number;
    direction: "up" | "down";
  }>,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(12 + positions.length * 55);
  accountDiscriminator("UserPositions").copy(data);
  data.writeUInt32LE(positions.length, 8);
  positions.forEach((position, index) => {
    const offset = 12 + index * 55;
    data.writeUInt16LE(position.marketId, offset);
    data.writeUInt32LE(position.nonce, offset + 2);
    data.fill(7, offset + 6, offset + 38);
    data.writeUInt32LE(position.collateral, offset + 38);
    data.writeBigInt64LE(position.entryPrice, offset + 42);
    data.writeUInt32LE(position.expiresAt, offset + 50);
    data.writeUInt8(position.direction === "up" ? 0 : 1, offset + 54);
  });
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

class FakeConnection implements PositionStreamConnection {
  callback: ((account: AccountInfo<Buffer>) => void) | null = null;
  removed: number[] = [];
  resolveInitial!: (account: AccountInfo<Buffer> | null) => void;
  readonly initial = new Promise<AccountInfo<Buffer> | null>((resolve) => {
    this.resolveInitial = resolve;
  });

  async getAccountInfo(): Promise<AccountInfo<Buffer> | null> {
    return this.initial;
  }

  onAccountChange(
    _address: PublicKey,
    callback: (account: AccountInfo<Buffer>) => void,
  ): number {
    this.callback = callback;
    return 31;
  }

  async removeAccountChangeListener(subscriptionId: number): Promise<void> {
    this.removed.push(subscriptionId);
  }
}

function snapshot(): MarketSnapshot {
  return {
    mode: "live",
    marketId: 1,
    marketLabel: "BTC / USD",
    gameLabel: "BTC PRICE RUSH",
    currentPrice: 101,
    priceExponent: 8,
    priceHistory: [],
    feedHealth: "live",
    feedAgeSeconds: 0,
    marketMode: "open",
    activePositions: 1,
    maxPositions: 8,
    walletAddress: PublicKey.unique().toBase58(),
    walletBalanceUsd: 99,
    fallbackClaimableUsd: 0,
    plays: [],
    capturedAt: 100_000,
  };
}

describe("routed ER position websocket", () => {
  it("keeps the hot-path nonce and capacity current from Market updates", () => {
    const next = applyMarketStreamUpdate(snapshot(), {
      activePositions: 3,
      nextPositionNonce: 17,
      marketMode: "open",
      receivedAt: 101_000,
    });

    expect(next.activePositions).toBe(3);
    expect(next.nextPositionNonce).toBe(17);
    expect(next.notice).toMatch(/Market/);
  });

  it("streams decoded positions, ignores a late stale read, and removes its listener", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const programId = PublicKey.unique();
    const connection = new FakeConnection();
    const updates: number[][] = [];
    const errors: unknown[] = [];
    const unsubscribe = subscribeUserPositions(
      {
        erEndpoint: "https://devnet-as.magicblock.app",
        programId: programId.toBase58(),
        userAddress: PublicKey.unique().toBase58(),
        marketId: 1,
      },
      (update) => updates.push(update.positions.map((position) => position.nonce)),
      (error) => errors.push(error),
      connection,
    );

    connection.callback?.(positionsAccount(programId, [{
      marketId: 1,
      nonce: 2,
      collateral: 1_000_000,
      entryPrice: 10_000_000_000n,
      expiresAt: 110,
      direction: "up",
    }]));
    connection.resolveInitial(positionsAccount(programId, [{
      marketId: 1,
      nonce: 1,
      collateral: 1_000_000,
      entryPrice: 10_000_000_000n,
      expiresAt: 110,
      direction: "up",
    }]));
    await Promise.resolve();

    expect(updates).toEqual([[2]]);
    expect(errors).toEqual([]);
    unsubscribe();
    await Promise.resolve();
    expect(connection.removed).toEqual([31]);
    vi.useRealTimers();
  });

  it("replaces snapshot plays from account changes and filters other markets", () => {
    const next = applyPositionStreamUpdate(snapshot(), {
      receivedAt: 100_000,
      positions: [
        {
          marketId: 1,
          nonce: 5,
          taskSalt: Buffer.alloc(32),
          collateral: 2_000_000,
          entryPrice: 10_000_000_000n,
          expiresAt: 110,
          direction: "up",
        },
        {
          marketId: 2,
          nonce: 9,
          taskSalt: Buffer.alloc(32),
          collateral: 3_000_000,
          entryPrice: 10_000_000_000n,
          expiresAt: 110,
          direction: "down",
        },
      ],
    });

    expect(next.plays).toHaveLength(1);
    expect(next.plays[0]).toMatchObject({
      id: "1-5",
      direction: "up",
      collateralUsd: 2,
      entryPrice: 100,
      status: "active",
      priceMovePercent: 1,
      liveProfitUsd: 9,
    });
    expect(next.notice).toMatch(/position websockets connected/);
  });
});
