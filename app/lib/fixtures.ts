import type { MarketSnapshot, Play, PricePoint } from "@/app/lib/domain";

const BASE_PRICE = 118_642.12;

function fixturePrice(timestamp: number): number {
  const seconds = timestamp / 1_000;
  const wave = Math.sin(seconds / 4.7) * 31 + Math.sin(seconds / 1.65) * 8;
  const drift = Math.sin(seconds / 19) * 22;
  return BASE_PRICE + wave + drift;
}

function makeHistory(now: number): PricePoint[] {
  return Array.from({ length: 91 }, (_, index) => {
    const timestamp = now - (90 - index) * 500;
    return { timestamp, price: fixturePrice(timestamp) };
  });
}

function makePlay(
  now: number,
  expiresAt: number,
  id: string,
  direction: "up" | "down",
  collateralUsd: number,
  status: Play["status"],
): Play {
  return {
    id,
    marketId: 1,
    direction,
    collateralUsd,
    entryPrice: fixturePrice(expiresAt - 10_000),
    openedAt: expiresAt - 10_000,
    expiresAt,
    refundAt: expiresAt + 10_000,
    status,
    estimateUsd: direction === "up" ? 3.4 : -1.1,
  };
}

export function createFixtureSnapshot(now = Date.now()): MarketSnapshot {
  const cycleStart = now - (now % 20_000);
  const activeExpiry = cycleStart + 15_000;
  const settlingExpiry = cycleStart - 2_000;
  return {
    mode: "fixture",
    marketId: 1,
    marketLabel: "BTC / USD",
    gameLabel: "BTC PRICE RUSH",
    currentPrice: fixturePrice(now),
    priceExponent: 8,
    priceHistory: makeHistory(now),
    feedHealth: "live",
    feedAgeSeconds: 0.3,
    marketMode: "open",
    activePositions: 3,
    maxPositions: 8,
    walletAddress: "9xKp…2VQm",
    walletBalanceUsd: 248.5,
    fallbackClaimableUsd: 0,
    plays: [
      makePlay(now, activeExpiry, "fixture-up", "up", 10, now < activeExpiry ? "active" : "settling"),
      makePlay(now, settlingExpiry, "fixture-down", "down", 5, "settling"),
      {
        ...makePlay(now, cycleStart - 22_000, "fixture-result", "up", 25, "won"),
        payoutUsd: 47.5,
        claimableUsd: 47.5,
        estimateUsd: undefined,
      },
    ],
    capturedAt: now,
    notice: "Fixture mode · live writes are off",
  };
}
