import type { Play } from "@/app/lib/domain";

export const PLAY_REFRESH_INTERVAL_MS = 750;
export const PLAY_RECONCILIATION_DELAY_MS = 4_000;

export function refreshedPositionsIncludeNewPlay(
  current: readonly Pick<Play, "id">[],
  refreshed: readonly Pick<Play, "id">[],
): boolean {
  const currentIds = new Set(current.map((play) => play.id));
  return refreshed.some((play) => !currentIds.has(play.id));
}

export function refreshedMarketAdvanced(
  currentNonce: number | undefined,
  refreshedNonce: number | undefined,
): boolean {
  return currentNonce !== undefined &&
    refreshedNonce !== undefined &&
    refreshedNonce > currentNonce;
}

export function schedulePlayReconciliation(
  refresh: () => void,
  reconcile: () => Promise<void>,
): () => void {
  const interval = globalThis.setInterval(refresh, PLAY_REFRESH_INTERVAL_MS);
  const timeout = globalThis.setTimeout(() => {
    void reconcile();
  }, PLAY_RECONCILIATION_DELAY_MS);

  return () => {
    globalThis.clearInterval(interval);
    globalThis.clearTimeout(timeout);
  };
}
