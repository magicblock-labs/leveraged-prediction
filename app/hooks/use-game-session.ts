"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import {
  createGameSessionFlow,
  validateGameSession,
  validateGameSessionToken,
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
  const [settingUp, setSettingUp] = useState(false);

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
      if (!stored.setupComplete) {
        await validateGameSessionToken(wallet.publicKey, stored);
        setSession(stored);
        setRemainingAllowanceUsd(null);
        setProgress({
          phase: "preparing-accounts",
          message: "Step 1 of 2 · Continue the remaining base-layer setup.",
        });
        setError(null);
        return;
      }
      const validated = await validateGameSession(wallet.publicKey, stored);
      setSession(stored);
      setRemainingAllowanceUsd(Number(validated.remainingAllowanceMinor) / 1_000_000);
      setProgress(null);
      setError(null);
    } catch (cause) {
      try {
        await validateGameSessionToken(wallet.publicKey, stored);
        const resumable = { ...stored, setupComplete: false };
        saveGameSession(resumable);
        setSession(resumable);
        setRemainingAllowanceUsd(null);
        setProgress({
          phase: "preparing-accounts",
          message: "Step 1 of 2 · Continue the remaining base-layer setup.",
        });
        setError(null);
      } catch {
        clearGameSession(wallet.publicKey, config.programId);
        setSession(null);
        setRemainingAllowanceUsd(null);
        setProgress(null);
        setError(cause instanceof Error ? cause.message : "Stored session is no longer valid");
      }
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
    const config = readClientLiveConfig();
    const existingSession = loadGameSession(wallet.publicKey, config.programId);
    setError(null);
    setSettingUp(true);
    setProgress(existingSession
      ? {
          phase: "preparing-accounts",
          message: "Step 1 of 2 · Resuming base-layer setup…",
        }
      : { phase: "creating", message: "Step 1 of 2 · Preparing the base-layer deposit…" });
    try {
      const created = await createGameSessionFlow(
        wallet.publicKey,
        allowanceUsd,
        wallet.signTransaction,
        setProgress,
        {
          existingSession,
          onSessionAvailable: (available) => {
            saveGameSession(available);
            setSession(available);
          },
        },
      );
      saveGameSession(created);
      setSession(created);
      const validated = await validateGameSession(wallet.publicKey, created);
      setRemainingAllowanceUsd(Number(validated.remainingAllowanceMinor) / 1_000_000);
      window.setTimeout(() => setProgress(null), 1_500);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session setup failed");
      return false;
    } finally {
      setSettingUp(false);
    }
  }, [wallet.publicKey, wallet.signTransaction]);

  return {
    session,
    ready: Boolean(session && remainingAllowanceUsd !== null && remainingAllowanceUsd > 0),
    busy: checking || settingUp,
    progress,
    hasStoredSession: Boolean(session),
    error,
    remainingAllowanceUsd,
    defaultAllowanceUsd: session
      ? Number(BigInt(session.allowanceMinor)) / 1_000_000
      : DEFAULT_SESSION_ALLOWANCE_USD,
    start,
    refresh,
  };
}
