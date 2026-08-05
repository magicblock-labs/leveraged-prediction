import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAY_RECONCILIATION_DELAY_MS,
  PLAY_REFRESH_INTERVAL_MS,
  refreshedMarketAdvanced,
  refreshedPositionsIncludeNewPlay,
  schedulePlayReconciliation,
} from "@/app/lib/live/play-reconciliation";

describe("submitted play reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a polled position that was not delivered by the websocket", () => {
    expect(refreshedPositionsIncludeNewPlay(
      [{ id: "1-40" }],
      [{ id: "1-40" }, { id: "1-41" }],
    )).toBe(true);
    expect(refreshedPositionsIncludeNewPlay(
      [{ id: "1-40" }],
      [{ id: "1-40" }],
    )).toBe(false);
  });

  it("accepts a polled market nonce that advanced without a websocket update", () => {
    expect(refreshedMarketAdvanced(41, 42)).toBe(true);
    expect(refreshedMarketAdvanced(42, 42)).toBe(false);
    expect(refreshedMarketAdvanced(undefined, 42)).toBe(false);
  });

  it("polls while waiting and performs one bounded reconciliation", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    const stop = schedulePlayReconciliation(refresh, reconcile);

    await vi.advanceTimersByTimeAsync(PLAY_RECONCILIATION_DELAY_MS);

    expect(refresh).toHaveBeenCalledTimes(
      Math.floor(PLAY_RECONCILIATION_DELAY_MS / PLAY_REFRESH_INTERVAL_MS),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(PLAY_RECONCILIATION_DELAY_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
