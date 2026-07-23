import { describe, expect, it } from "vitest";
import { createChartGeometry, nicePriceStep } from "@/app/lib/chart-geometry";

describe("chart geometry", () => {
  it("shows thirty seconds of history and fifteen seconds of future time", () => {
    const now = 1_000_000;
    const geometry = createChartGeometry(
      1_200,
      800,
      [{ timestamp: now, price: 65_000 }],
      [],
      65_000,
      now,
    );
    expect(geometry.x(now - 30_000)).toBeCloseTo(geometry.plotLeft);
    expect(geometry.x(now)).toBeCloseTo(geometry.plotLeft + geometry.plotWidth * (2 / 3));
    expect(geometry.x(now + 15_000)).toBeCloseTo(geometry.plotRight);
    expect(geometry.timeOffsetAt(geometry.plotLeft)).toBeCloseTo(-30_000);
    expect(geometry.timeOffsetAt(geometry.plotRight)).toBeCloseTo(15_000);
  });

  it("fits recent prices and active entry prices inside the responsive plot", () => {
    const now = 1_000_000;
    const geometry = createChartGeometry(
      390,
      844,
      [
        { timestamp: now - 10_000, price: 64_950 },
        { timestamp: now, price: 65_075 },
      ],
      [{
        id: "play",
        marketId: 1,
        direction: "up",
        collateralUsd: 10,
        entryPrice: 64_900,
        openedAt: now - 1_000,
        expiresAt: now + 9_000,
        refundAt: now + 19_000,
        status: "active",
      }],
      65_075,
      now,
    );
    for (const price of [64_900, 64_950, 65_075]) {
      expect(geometry.y(price)).toBeGreaterThanOrEqual(geometry.plotTop);
      expect(geometry.y(price)).toBeLessThanOrEqual(geometry.plotBottom);
    }
  });

  it("chooses stable human-readable price steps", () => {
    expect(nicePriceStep(0.1)).toBe(10);
    expect(nicePriceStep(0.01)).toBe(1);
  });
});
