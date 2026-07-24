"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchCompletedPositions,
  fetchLeaderboard,
  indexerApiUrl,
  IndexerApiError,
  type IndexedPosition,
  type IndexerMeta,
  type LeaderboardEntry,
  withCursorRecovery,
} from "@/app/lib/indexer/client";

type IndexedStatus = "disabled" | "loading" | "ready" | "stale" | "unavailable";

interface IndexedHistoryState {
  status: IndexedStatus;
  leaderboard: LeaderboardEntry[];
  positions: IndexedPosition[];
  leaderboardMeta: IndexerMeta | null;
  positionMeta: IndexerMeta | null;
  message: string | null;
  loadingMore: boolean;
  restartedPagination: boolean;
  loadMore(): void;
  retry(): void;
}

export function useIndexedHistory(
  wallet: string | null,
  marketId: number | null,
): IndexedHistoryState {
  const baseUrl = indexerApiUrl();
  const [generation, setGeneration] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [positions, setPositions] = useState<IndexedPosition[]>([]);
  const [leaderboardMeta, setLeaderboardMeta] = useState<IndexerMeta | null>(null);
  const [positionMeta, setPositionMeta] = useState<IndexerMeta | null>(null);
  const [status, setStatus] = useState<IndexedStatus>(
    baseUrl && marketId !== null ? "loading" : "disabled",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restartedPagination, setRestartedPagination] = useState(false);

  useEffect(() => {
    if (!baseUrl || marketId === null) return;
    const controller = new AbortController();
    const history = wallet
      ? fetchCompletedPositions(baseUrl, wallet, marketId, undefined, controller.signal)
      : Promise.resolve(null);
    void Promise.all([
      fetchLeaderboard(baseUrl, marketId, undefined, controller.signal),
      history,
    ])
      .then(([leaders, completed]) => {
        setLeaderboard(leaders.data);
        setLeaderboardMeta(leaders.meta);
        setPositions(completed?.data ?? []);
        setPositionMeta(completed?.meta ?? null);
        setStatus(leaders.meta.stale || completed?.meta.stale ? "stale" : "ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("unavailable");
        setMessage(
          error instanceof IndexerApiError
            ? error.message
            : "History is temporarily unavailable. Live play still works.",
        );
      });
    return () => controller.abort();
  }, [baseUrl, generation, marketId, wallet]);

  const loadMore = useCallback(() => {
    if (
      !baseUrl ||
      !wallet ||
      marketId === null ||
      !positionMeta?.next_cursor ||
      loadingMore
    ) return;
    setLoadingMore(true);
    void withCursorRecovery(
      (cursor) => fetchCompletedPositions(baseUrl, wallet, marketId, cursor),
      positionMeta.next_cursor,
    )
      .then(({ page, restarted }) => {
        setPositions((current) => (restarted ? page.data : [...current, ...page.data]));
        setPositionMeta(page.meta);
        setRestartedPagination(restarted);
        setStatus(page.meta.stale ? "stale" : "ready");
      })
      .catch((error: unknown) => {
        setStatus("unavailable");
        setMessage(
          error instanceof IndexerApiError
            ? error.message
            : "History is temporarily unavailable. Live play still works.",
        );
      })
      .finally(() => setLoadingMore(false));
  }, [baseUrl, loadingMore, marketId, positionMeta, wallet]);

  return {
    status,
    leaderboard,
    positions,
    leaderboardMeta,
    positionMeta,
    message,
    loadingMore,
    restartedPagination,
    loadMore,
    retry: () => {
      setStatus("loading");
      setMessage(null);
      setGeneration((value) => value + 1);
    },
  };
}
