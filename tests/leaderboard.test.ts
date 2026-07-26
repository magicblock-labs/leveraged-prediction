import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLeaderboardResult,
  formatLeaderboardUsdc,
} from "@/app/lib/leaderboard";

const wallet = "11111111111111111111111111111111";
const otherWallet = "Vote111111111111111111111111111111111111111";

function jsonResponse(data: unknown, meta: Record<string, unknown>) {
  return new Response(JSON.stringify({ data, meta }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("leaderboard indexer client", () => {
  it("formats USDC minor units without using floating-point arithmetic", () => {
    expect(formatLeaderboardUsdc("0")).toBe("$0.00");
    expect(formatLeaderboardUsdc("123456789")).toBe("$123.45");
    expect(formatLeaderboardUsdc("1000000000000")).toBe("$1,000,000.00");
    expect(formatLeaderboardUsdc(null)).toBe("—");
  });

  it("paginates rankings, totals volume, and reads connected user stats", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === `/v1/users/${wallet}/stats`) {
        return jsonResponse({
          rank: 1,
          user: wallet,
          trades: 4,
          wins: 3,
          losses: 1,
          volume: "1000000",
        }, { stale: false });
      }
      if (url.searchParams.get("cursor") === "page-2") {
        return jsonResponse([{
          rank: 2,
          user: otherWallet,
          trades: 2,
          wins: 1,
          losses: 1,
          volume: "2500000",
        }], { stale: true });
      }
      return jsonResponse([{
        rank: 1,
        user: wallet,
        trades: 4,
        wins: 3,
        losses: 1,
        volume: "1000000",
      }], { stale: false, next_cursor: "page-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLeaderboardResult(
      "https://indexer.example",
      1,
      wallet,
      new AbortController().signal,
    );

    expect(result.entries).toHaveLength(2);
    expect(result.totalVolume).toBe("3500000");
    expect(result.userStats).toMatchObject({ rank: 1, trades: 4, wins: 3 });
    expect(result.stale).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
