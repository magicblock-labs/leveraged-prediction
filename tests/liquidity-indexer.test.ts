import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiquidityIndexerResult,
  summarizeLiquidityHistory,
  type IndexedLiquidityEvent,
} from "@/app/lib/liquidity-indexer";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function event(
  eventKind: IndexedLiquidityEvent["eventKind"],
  shares: string,
  assets: string | null = null,
): IndexedLiquidityEvent {
  return { eventKind, shares, assets };
}

describe("liquidity indexer", () => {
  it("tracks the remaining deposited cost basis through proportional withdrawals", () => {
    const summary = summarizeLiquidityHistory([
      event("withdrawal_executed", "25", "400"),
      event("deposit", "50", "600"),
      event("deposit", "100", "1000"),
    ]);

    expect(summary).toEqual({
      depositedMinor: "1333",
      indexedShares: "125",
    });
  });

  it("loads the market summary and every liquidity-history page", async () => {
    const wallet = "9g9n7TArsFPw7GvPuU8d5NTSAv1mr1gdfDhu97LqryBw";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/markets/1/summary")) {
        return new Response(JSON.stringify({
          data: {
            market_id: 1,
            mode: "open",
            total_shares: "125",
            active_positions: 0,
            pool_balance: "1450",
          },
          meta: {
            as_of: "2026-07-28T00:00:00Z",
            stale: false,
          },
        }));
      }
      if (url.includes("cursor=next")) {
        return new Response(JSON.stringify({
          data: [{
            event_kind: "deposit",
            market_id: 1,
            user: wallet,
            assets: "1000",
            shares: "100",
          }],
          meta: {
            as_of: "2026-07-28T00:00:02Z",
            stale: false,
          },
        }));
      }
      return new Response(JSON.stringify({
        data: [{
          event_kind: "deposit",
          market_id: 1,
          user: wallet,
          assets: "600",
          shares: "50",
        }],
        meta: {
          as_of: "2026-07-28T00:00:01Z",
          stale: false,
          next_cursor: "next",
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLiquidityIndexerResult(
      "https://indexer.example",
      1,
      wallet,
      new AbortController().signal,
    );

    expect(result).toEqual({
      market: {
        marketMode: "open",
        totalShares: "125",
        activePositions: 0,
        poolBalanceMinor: "1450",
      },
      depositedMinor: "1600",
      indexedShares: "150",
      stale: false,
      asOf: "2026-07-28T00:00:02Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed precision fields from the indexer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        market_id: 1,
        mode: "open",
        total_shares: 125,
        active_positions: 0,
        pool_balance: "1450",
      },
      meta: {
        as_of: "2026-07-28T00:00:00Z",
        stale: false,
      },
    }))));

    await expect(fetchLiquidityIndexerResult(
      "https://indexer.example",
      1,
      null,
      new AbortController().signal,
    )).rejects.toThrow("invalid total shares");
  });
});
