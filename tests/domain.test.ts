import { describe, expect, it } from "vitest";
import { maximumProfit, playStatusAt, type Play } from "@/app/lib/domain";

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
  it("shows the capped profit after the 10% profit fee", () => {
    expect(maximumProfit(10)).toBe(9);
  });

  it("keeps an expired play in settling before the refund deadline", () => {
    expect(playStatusAt(play, 10_999)).toBe("active");
    expect(playStatusAt(play, 11_000)).toBe("settling");
    expect(playStatusAt(play, 20_999)).toBe("settling");
    expect(playStatusAt(play, 21_000)).toBe("refunding");
  });
});
