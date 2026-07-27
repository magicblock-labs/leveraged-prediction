import { describe, expect, it } from "vitest";
import type { Play } from "@/app/lib/domain";
import {
  positionProfitUsd,
  positionWatchState,
  winProfitUsd,
} from "@/app/lib/position-presentation";

const active: Play = {
  id: "1-14",
  marketId: 1,
  direction: "up",
  collateralUsd: 10,
  entryPrice: 64_000,
  openedAt: 1_000,
  expiresAt: 11_000,
  refundAt: 21_000,
  status: "active",
  priceMovePercent: 0.04,
  liveProfitUsd: 40,
};

describe("position presentation", () => {
  it("drives the live countdown and ahead state from the round clock", () => {
    expect(positionWatchState(active, 6_000)).toEqual({
      status: "active",
      progress: 0.5,
      remainingSeconds: 5,
      result: "ahead",
      isFinalSeconds: false,
      finishLabel: "Finish above $64,000",
    });
  });

  it("marks the last three seconds without treating settlement as active", () => {
    expect(positionWatchState(active, 8_001).isFinalSeconds).toBe(true);
    expect(positionWatchState(active, 11_001)).toMatchObject({
      status: "settling",
      remainingSeconds: 0,
      isFinalSeconds: false,
    });
  });

  it("uses the directed price move for chasing and level states", () => {
    expect(
      positionWatchState({ ...active, priceMovePercent: -0.001 }, 2_000)
        .result,
    ).toBe("chasing");
    expect(
      positionWatchState({ ...active, priceMovePercent: 0 }, 2_000).result,
    ).toBe("level");
  });

  it("shows profit rather than total payout in the win moment", () => {
    expect(
      winProfitUsd({ ...active, status: "won", payoutUsd: 55 }),
    ).toBe(45);
    expect(winProfitUsd(active)).toBeNull();
  });

  it("calculates positive, negative, and zero terminal profit from payout", () => {
    expect(positionProfitUsd({ ...active, status: "won", payoutUsd: 28 })).toBe(18);
    expect(positionProfitUsd({ ...active, status: "lost", payoutUsd: 0 })).toBe(-10);
    expect(
      positionProfitUsd({ ...active, status: "refunded", payoutUsd: 10 }),
    ).toBe(0);
  });
});
