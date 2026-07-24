"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LiquiditySnapshot,
  LiquiditySnapshotError,
} from "@/app/lib/liquidity";

const POLL_INTERVAL_MS = 3_000;

export function useLiquiditySnapshot(walletAddress: string | null) {
  const [snapshot, setSnapshot] = useState<LiquiditySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const requestInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const query = walletAddress
        ? `?wallet=${encodeURIComponent(walletAddress)}`
        : "";
      const response = await fetch(`/api/liquidity${query}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as
        | LiquiditySnapshot
        | LiquiditySnapshotError;
      if (!response.ok || "error" in body) {
        throw new Error(
          "error" in body ? body.error : `Liquidity snapshot failed (${response.status})`,
        );
      }
      setSnapshot(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Liquidity refresh failed");
    } finally {
      requestInFlight.current = false;
      setRefreshing(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [refresh]);

  return { snapshot, error, refreshing, refresh };
}
