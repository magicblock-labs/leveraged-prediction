"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot, SnapshotError } from "@/app/lib/domain";

export function useGameSnapshot(walletAddress: string | null) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const requestInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const query = walletAddress ? `?wallet=${encodeURIComponent(walletAddress)}` : "";
      const response = await fetch(`/api/snapshot${query}`, { cache: "no-store" });
      const body = (await response.json()) as MarketSnapshot | SnapshotError;
      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : `Snapshot failed (${response.status})`);
      }
      setSnapshot(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Snapshot refresh failed");
    } finally {
      requestInFlight.current = false;
      setRefreshing(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 750);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [refresh]);

  return { snapshot, error, refreshing, refresh };
}
