import { describe, expect, it } from "vitest";
import {
  assetsForShares,
  formatShares,
  formatUsdcMinor,
  guardedMinimum,
  maximumRemovableShares,
  parseUsdcInput,
  sharesForAssetsRoundUp,
  sharesForDeposit,
} from "@/app/lib/liquidity";

describe("liquidity quotes", () => {
  it("parses and formats six-decimal USDC without floating point", () => {
    expect(parseUsdcInput("25")).toBe(25_000_000n);
    expect(parseUsdcInput("25.123456")).toBe(25_123_456n);
    expect(parseUsdcInput("0")).toBeNull();
    expect(parseUsdcInput("1.1234567")).toBeNull();
    expect(formatUsdcMinor(25_123_456n)).toBe("25.12");
    expect(formatUsdcMinor(1_234_567_890n)).toBe("1,234.56");
    expect(formatShares(123_456_789_012_345_678n))
      .toBe("123,456,789,012,345,678");
  });

  it("matches the contract's proportional share math", () => {
    expect(sharesForDeposit(50n, 200n, 100n)).toBe(25n);
    expect(sharesForDeposit(100n, 7n, 0n)).toBe(107n);
    expect(assetsForShares(25n, 250n, 125n)).toBe(50n);
    expect(sharesForAssetsRoundUp(51n, 250n, 125n)).toBe(26n);
  });

  it("applies the quote guard and open-market liquidity floor", () => {
    expect(guardedMinimum(10_000n)).toBe(9_950n);
    expect(
      maximumRemovableShares(
        60_000_000_000n,
        150_000_000_000n,
        150_000_000_000n,
        "open",
      ),
    ).toBe(50_000_000_000n);
    expect(
      maximumRemovableShares(
        60_000_000_000n,
        150_000_000_000n,
        150_000_000_000n,
        "close-only",
      ),
    ).toBe(60_000_000_000n);
  });
});
