"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { Direction, MarketSnapshot, Play } from "@/app/lib/domain";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import {
  clearOpenIntent,
  loadOpenIntent,
  requiresIntentRecovery,
  type OpenPositionIntent,
} from "@/app/lib/live/intent-store";
import {
  claimFallbackPayoutFlow,
  openPositionFlow,
  recoverOpenPositionIntent,
  type TransactionProgress,
} from "@/app/lib/live/transaction-flow";
import type { StoredGameSession } from "@/app/lib/live/session-store";

function intentPlay(intent: OpenPositionIntent, snapshot: MarketSnapshot): Play {
  return {
    id: `intent-${intent.id}`,
    marketId: intent.marketId,
    direction: intent.direction,
    collateralUsd: Number(BigInt(intent.collateralMinor)) / 1_000_000,
    entryPrice: snapshot.currentPrice,
    openedAt: intent.createdAt,
    expiresAt: intent.createdAt + 10_000,
    refundAt: intent.createdAt + 20_000,
    status: "submitting",
  };
}

export function usePlayTransaction(
  snapshot: MarketSnapshot | null,
  refresh: () => Promise<void> | void,
  session: StoredGameSession | null,
  refreshSession: () => Promise<void> | void,
) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [progress, setProgress] = useState<TransactionProgress | null>(null);
  const [intent, setIntent] = useState<OpenPositionIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.publicKey || snapshot?.mode !== "live") return;
    const walletAddress = wallet.publicKey.toBase58();
    const timeout = window.setTimeout(() => {
      const config = readClientLiveConfig();
      const stored = loadOpenIntent(walletAddress, config.marketId);
      if (stored && requiresIntentRecovery(stored)) setIntent(stored);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [snapshot?.mode, wallet.publicKey]);

  useEffect(() => {
    if (!intent || intent.status !== "accepted" || intent.nonce === undefined || !snapshot) return;
    if (!snapshot.plays.some((play) => play.id === `${intent.marketId}-${intent.nonce}`)) return;
    const timeout = window.setTimeout(() => {
      clearOpenIntent(intent.user, intent.marketId);
      setIntent(null);
      setProgress(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [intent, snapshot]);

  const submit = useCallback(async (direction: Direction, amount: number) => {
    if (snapshot?.mode !== "live") return;
    if (!wallet.publicKey) {
      setVisible(true);
      return;
    }
    if (!session) {
      setError("Start a play session before choosing Up or Down");
      return;
    }
    setError(null);
    try {
      const result = await openPositionFlow(
        wallet.publicKey,
        direction,
        amount,
        session,
        (next) => {
          setProgress(next);
          setIntent(next.intent);
        },
      );
      setIntent(result.intent);
      await Promise.all([refresh(), refreshSession()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Play submission failed");
      setProgress(null);
      const config = readClientLiveConfig();
      const stored = loadOpenIntent(wallet.publicKey.toBase58(), config.marketId);
      setIntent(stored && requiresIntentRecovery(stored) ? stored : null);
    }
  }, [refresh, refreshSession, session, setVisible, snapshot?.mode, wallet.publicKey]);

  const recover = useCallback(async () => {
    if (!wallet.publicKey || !intent) return;
    setError(null);
    setProgress({ phase: "recovering", message: "Checking the previous play on the ER…", intent });
    try {
      const result = await recoverOpenPositionIntent(wallet.publicKey, intent);
      setIntent(result.intent);
      setProgress(null);
      await refresh();
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : "Status check failed");
    }
  }, [intent, refresh, wallet.publicKey]);

  const claimFallback = useCallback(async () => {
    if (!wallet.publicKey) {
      setVisible(true);
      return;
    }
    if (!wallet.signTransaction) {
      setError("This wallet must support transaction signing to claim a payout");
      return;
    }
    setError(null);
    setClaimStatus("Checking the protected payout balance…");
    try {
      await claimFallbackPayoutFlow(
        wallet.publicKey,
        wallet.signTransaction,
        setClaimStatus,
      );
      setClaimStatus("Payout claimed");
      await refresh();
      window.setTimeout(() => setClaimStatus(null), 1_500);
    } catch (cause) {
      setClaimStatus(null);
      setError(cause instanceof Error ? cause.message : "Payout claim failed");
    }
  }, [refresh, setVisible, wallet.publicKey, wallet.signTransaction]);

  const needsRecovery = Boolean(intent && requiresIntentRecovery(intent));
  const pendingPlay = useMemo(
    () => {
      if (!intent || !snapshot) return null;
      if (intent.status === "failed") return null;
      if (
        intent.nonce !== undefined &&
        snapshot.plays.some((play) => play.id === `${intent.marketId}-${intent.nonce}`)
      ) return null;
      return intentPlay(intent, snapshot);
    },
    [intent, snapshot],
  );
  const statusMessage = claimStatus ?? progress?.message ?? intent?.message ?? error ?? (
    snapshot?.mode === "live" && !wallet.publicKey
      ? "Connect a wallet to play"
      : snapshot?.mode === "live" && !session
        ? "Start a session to play"
        : null
  );

  return {
    submit,
    recover,
    claimFallback,
    pendingPlay,
    busy: Boolean(progress || claimStatus),
    claimBusy: Boolean(claimStatus),
    needsRecovery,
    statusMessage,
  };
}
