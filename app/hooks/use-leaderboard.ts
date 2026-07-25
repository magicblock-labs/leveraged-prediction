"use client";

import { useEffect, useState } from "react";
import {
  fetchLeaderboardResult,
  leaderboardApiUrl,
  type LeaderboardResult,
} from "@/app/lib/leaderboard";

export type LeaderboardStatus =
  | "disabled"
  | "loading"
  | "ready"
  | "stale"
  | "unavailable";

const EMPTY_RESULT: LeaderboardResult = {
  entries: [],
  userStats: null,
  totalVolume: null,
  stale: false,
};

interface LeaderboardState {
  requestKey: string;
  result: LeaderboardResult;
  status: "ready" | "stale" | "unavailable";
  error: string | null;
}

export function useLeaderboard(wallet: string | null) {
  const baseUrl = leaderboardApiUrl();
  const marketId = Number(
    process.env.NEXT_PUBLIC_LEVERAGED_PREDICTION_MARKET_ID ?? "1",
  );
  const configError =
    !Number.isSafeInteger(marketId) || marketId < 0 || marketId > 65_535
      ? "Leaderboard market configuration is invalid"
      : null;
  const [generation, setGeneration] = useState(0);
  const requestKey = `${baseUrl ?? ""}|${marketId}|${wallet ?? ""}|${generation}`;
  const [state, setState] = useState<LeaderboardState | null>(null);

  useEffect(() => {
    if (!baseUrl || configError) return;

    const controller = new AbortController();
    void fetchLeaderboardResult(baseUrl, marketId, wallet, controller.signal)
      .then((next) => {
        setState({
          requestKey,
          result: next,
          status: next.stale ? "stale" : "ready",
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setState({
          requestKey,
          result: EMPTY_RESULT,
          status: "unavailable",
          error: cause instanceof Error
            ? cause.message
            : "Leaderboard data is temporarily unavailable",
        });
      });
    return () => controller.abort();
  }, [baseUrl, configError, marketId, requestKey, wallet]);

  const settledState = state?.requestKey === requestKey ? state : null;
  const status: LeaderboardStatus = !baseUrl
    ? "disabled"
    : configError
      ? "unavailable"
      : settledState?.status ?? "loading";
  const result = settledState?.result ?? EMPTY_RESULT;

  return {
    ...result,
    status,
    error: configError ?? settledState?.error ?? null,
    retry: () => setGeneration((value) => value + 1),
  };
}
