import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLeaderboard,
  formatUsdcMinorUnits,
  IndexerApiError,
  withCursorRecovery,
  type IndexerEnvelope,
} from "@/app/lib/indexer/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("indexer API client", () => {
  it("restarts keyset pagination when a projection refresh invalidates the cursor", async () => {
    const calls: Array<string | undefined> = [];
    const page: IndexerEnvelope<string[]> = {
      data: ["newest"],
      meta: {
        as_of: "2026-07-24T00:00:00Z",
        projection_high_water_mark: 42,
        refresh_version: 8,
        stale: false,
      },
    };

    const result = await withCursorRecovery(async (cursor) => {
      calls.push(cursor);
      if (cursor) throw new IndexerApiError("cursor_stale", "refreshed", 409);
      return page;
    }, "old-cursor");

    expect(calls).toEqual(["old-cursor", undefined]);
    expect(result).toEqual({ page, restarted: true });
  });

  it("maps a network outage to index_unavailable without touching gameplay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(fetchLeaderboard("http://indexer.test", 1)).rejects.toMatchObject({
      code: "index_unavailable",
      status: 0,
    });
  });

  it("formats token minor-unit strings without crossing JavaScript number precision", () => {
    expect(formatUsdcMinorUnits("9007199254740993")).toBe("$9007199254.74");
    expect(formatUsdcMinorUnits("-1234567")).toBe("−$1.23");
    expect(formatUsdcMinorUnits("42")).toBe("$0.00");
    expect(formatUsdcMinorUnits(null)).toBe("—");
  });
});
