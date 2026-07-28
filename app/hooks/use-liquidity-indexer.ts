"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchLiquidityIndexerResult,
  liquidityIndexerApiUrl,
  type LiquidityIndexerResult,
  type LiquidityIndexerStatus,
} from "@/app/lib/liquidity-indexer";

const POLL_INTERVAL_MS = 30_000;
const EMPTY_RESULT: LiquidityIndexerResult = {
  market: {
    marketMode: null,
    totalShares: null,
    activePositions: null,
    poolBalanceMinor: null,
  },
  depositedMinor: null,
  indexedShares: null,
  stale: false,
  asOf: "",
};

interface LiquidityIndexerState {
  requestKey: string;
  result: LiquidityIndexerResult;
  status: "ready" | "stale" | "unavailable";
  error: string | null;
}

export function useLiquidityIndexer(
  wallet: string | null,
  marketId: number | null,
) {
  const baseUrl = liquidityIndexerApiUrl();
  const [generation, setGeneration] = useState(0);
  const requestKey =
    `${baseUrl ?? ""}|${marketId ?? ""}|${wallet ?? ""}|${generation}`;
  const [state, setState] = useState<LiquidityIndexerState | null>(null);
  const configError = marketId !== null &&
      (!Number.isSafeInteger(marketId) || marketId < 0 || marketId > 65_535)
    ? "Liquidity market configuration is invalid"
    : null;

  useEffect(() => {
    if (!baseUrl || marketId === null || configError) return;
    const controller = new AbortController();
    let requestInFlight = false;

    const load = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const result = await fetchLiquidityIndexerResult(
          baseUrl,
          marketId,
          wallet,
          controller.signal,
        );
        setState({
          requestKey,
          result,
          status: result.stale ? "stale" : "ready",
          error: null,
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setState({
          requestKey,
          result: EMPTY_RESULT,
          status: "unavailable",
          error: cause instanceof Error
            ? cause.message
            : "Liquidity history is temporarily unavailable",
        });
      } finally {
        requestInFlight = false;
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [baseUrl, configError, marketId, requestKey, wallet]);

  const settledState = state?.requestKey === requestKey ? state : null;
  const status: LiquidityIndexerStatus = !baseUrl
    ? "disabled"
    : configError
      ? "unavailable"
      : marketId === null
        ? "loading"
        : settledState?.status ?? "loading";
  const refresh = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  return {
    ...(settledState?.result ?? EMPTY_RESULT),
    status,
    error: configError ?? settledState?.error ?? null,
    refresh,
  };
}
