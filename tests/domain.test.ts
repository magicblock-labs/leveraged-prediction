import { describe, expect, it } from "vitest";
import {
  estimateProfit,
  maximumProfit,
  playStatusAt,
  priceMovePercent,
  type Play,
} from "@/app/lib/domain";

const play: Play = {
  id: "1-1",
  marketId: 1,
  direction: "up",
  collateralUsd: 10,
  entryPrice: 100,
  openedAt: 1_000,
  expiresAt: 11_000,
  refundAt: 21_000,
  status: "active",
};

describe("frontend economics and lifecycle", () => {
  it("shows the 5x gross profit cap after the 10% profit fee", () => {
    expect(maximumProfit(10)).toBe(45);
  });

  it("estimates 1000x price movement and caps both sides", () => {
    expect(estimateProfit(10, 100, 100.1, "up")).toBeCloseTo(9);
    expect(estimateProfit(10, 100, 99.9, "down")).toBeCloseTo(9);
    expect(estimateProfit(10, 100, 101, "up")).toBe(45);
    expect(estimateProfit(10, 100, 99, "up")).toBe(-10);
    expect(priceMovePercent(100, 100.1, "up")).toBeCloseTo(0.1);
    expect(priceMovePercent(100, 99.9, "down")).toBeCloseTo(0.1);
  });

  it("keeps an expired play in settling before the refund deadline", () => {
    expect(playStatusAt(play, 10_999)).toBe("active");
    expect(playStatusAt(play, 11_000)).toBe("settling");
    expect(playStatusAt(play, 20_999)).toBe("settling");
    expect(playStatusAt(play, 21_000)).toBe("refunding");
  });
});
