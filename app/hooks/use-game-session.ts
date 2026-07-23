"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import {
  createGameSessionFlow,
  validateGameSession,
  type SessionProgress,
} from "@/app/lib/live/transaction-flow";
import {
  clearGameSession,
  DEFAULT_SESSION_ALLOWANCE_USD,
  loadGameSession,
  saveGameSession,
  type StoredGameSession,
} from "@/app/lib/live/session-store";

export function useGameSession() {
  const wallet = useWallet();
  const [session, setSession] = useState<StoredGameSession | null>(null);
  const [remainingAllowanceUsd, setRemainingAllowanceUsd] = useState<number | null>(null);
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    if (!wallet.publicKey) {
      setSession(null);
      setRemainingAllowanceUsd(null);
      return;
    }
    const config = readClientLiveConfig();
    const stored = loadGameSession(wallet.publicKey, config.programId);
    if (!stored) {
      setSession(null);
      setRemainingAllowanceUsd(null);
      return;
    }
    setChecking(true);
    try {
      const validated = await validateGameSession(wallet.publicKey, stored);
      setSession(stored);
      setRemainingAllowanceUsd(Number(validated.remainingAllowanceMinor) / 1_000_000);
      setError(null);
    } catch (cause) {
      clearGameSession(wallet.publicKey, config.programId);
      setSession(null);
      setRemainingAllowanceUsd(null);
      setError(cause instanceof Error ? cause.message : "Stored session is no longer valid");
    } finally {
      setChecking(false);
    }
  }, [wallet.publicKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const delay = Math.max(0, session.validUntil * 1_000 - Date.now() + 250);
    const timeout = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timeout);
  }, [refresh, session]);

  const start = useCallback(async (allowanceUsd: number) => {
    if (!wallet.publicKey) return;
    if (!wallet.signTransaction) {
      setError("This wallet must support transaction signing to start a session");
      return;
    }
    setError(null);
    setProgress({ phase: "creating", message: "Preparing your session…" });
    try {
      const created = await createGameSessionFlow(
        wallet.publicKey,
        allowanceUsd,
        wallet.signTransaction,
        setProgress,
      );
      saveGameSession(created);
      setSession(created);
      const validated = await validateGameSession(wallet.publicKey, created);
      setRemainingAllowanceUsd(Number(validated.remainingAllowanceMinor) / 1_000_000);
      window.setTimeout(() => setProgress(null), 1_500);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : "Session setup failed");
    }
  }, [wallet.publicKey, wallet.signTransaction]);

  return {
    session,
    ready: Boolean(session && remainingAllowanceUsd !== null && remainingAllowanceUsd > 0),
    busy: checking || Boolean(progress),
    progress: progress?.message ?? null,
    error,
    remainingAllowanceUsd,
    defaultAllowanceUsd: DEFAULT_SESSION_ALLOWANCE_USD,
    start,
    refresh,
  };
}
