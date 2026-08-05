"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  prepareOpenPosition,
  recoverOpenPositionIntent,
  refreshPreparedOpenPosition,
  type PreparedOpenPositionContext,
  type TransactionProgress,
} from "@/app/lib/live/transaction-flow";
import type { StoredGameSession } from "@/app/lib/live/session-store";
import { schedulePlayReconciliation } from "@/app/lib/live/play-reconciliation";

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
  const [preparedKey, setPreparedKey] = useState<string | null>(null);
  const preparedRef = useRef<PreparedOpenPositionContext | null>(null);
  const snapshotMode = snapshot?.mode;
  const snapshotMarketId = snapshot?.marketId;
  const snapshotWalletAddress = snapshot?.walletAddress ?? null;
  const snapshotErEndpoint = snapshot?.erEndpoint;
  const snapshotCollateralMint = snapshot?.collateralMint;
  const snapshotOracleAddress = snapshot?.oracleAddress;
  const preparationKey = wallet.publicKey &&
    session &&
    snapshotMode === "live" &&
    snapshotMarketId !== undefined &&
    snapshotErEndpoint &&
    snapshotCollateralMint &&
    snapshotOracleAddress
    ? [
        wallet.publicKey.toBase58(),
        session.sessionToken,
        snapshotMarketId,
        snapshotErEndpoint,
        snapshotCollateralMint,
        snapshotOracleAddress,
      ].join(":")
    : null;
  const submissionReady = preparationKey !== null &&
    preparedKey === preparationKey;

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
    if (!intent || intent.nonce === undefined || !snapshot) return;
    if (!snapshot.plays.some((play) => play.id === `${intent.marketId}-${intent.nonce}`)) return;
    const timeout = window.setTimeout(() => {
      clearOpenIntent(intent.user, intent.marketId);
      setIntent(null);
      setProgress(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [intent, snapshot]);

  useEffect(() => {
    if (
      !intent ||
      intent.status !== "confirming" ||
      !intent.erSignature ||
      !wallet.publicKey
    ) return;

    let active = true;
    const stop = schedulePlayReconciliation(
      () => {
        void Promise.allSettled([
          Promise.resolve().then(refresh),
          Promise.resolve().then(refreshSession),
        ]);
      },
      async () => {
        try {
          const result = await recoverOpenPositionIntent(wallet.publicKey!, intent);
          if (!active) return;
          setError(null);
          if (result.accepted) {
            await Promise.allSettled([
              Promise.resolve().then(refresh),
              Promise.resolve().then(refreshSession),
            ]);
            if (!active) return;
            clearOpenIntent(intent.user, intent.marketId);
            setIntent(null);
          } else {
            setIntent(result.intent);
          }
          setProgress(null);
        } catch (cause) {
          if (!active) return;
          setProgress(null);
          setError(cause instanceof Error
            ? `Position confirmation is delayed: ${cause.message}`
            : "Position confirmation is delayed. Check status before playing again.");
        }
      },
    );

    return () => {
      active = false;
      stop();
    };
  }, [intent, refresh, refreshSession, wallet.publicKey]);

  useEffect(() => {
    if (
      !preparationKey ||
      !wallet.publicKey ||
      !session ||
      snapshotMarketId === undefined
    ) {
      preparedRef.current = null;
      return;
    }

    let active = true;
    let interval: number | null = null;
    const prepare = async () => {
      try {
        const prepared = await prepareOpenPosition(
          wallet.publicKey!,
          session,
          {
            marketId: snapshotMarketId,
            walletAddress: snapshotWalletAddress,
            erEndpoint: snapshotErEndpoint,
            collateralMint: snapshotCollateralMint,
            oracleAddress: snapshotOracleAddress,
          },
        );
        if (!active) return;
        preparedRef.current = prepared;
        setPreparedKey(preparationKey);
        interval = window.setInterval(() => {
          void refreshPreparedOpenPosition(prepared).catch((cause) => {
            console.warn("[play:prepare] blockhash refresh failed", cause);
          });
        }, 2_000);
      } catch (cause) {
        if (!active) return;
        preparedRef.current = null;
        setPreparedKey(null);
        setError(cause instanceof Error ? cause.message : "Instant play is not ready");
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !preparedRef.current) return;
      void refreshPreparedOpenPosition(preparedRef.current).catch((cause) => {
        console.warn("[play:prepare] visible-tab blockhash refresh failed", cause);
      });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void prepare();

    return () => {
      active = false;
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      preparedRef.current = null;
    };
  }, [
    preparationKey,
    session,
    snapshotCollateralMint,
    snapshotErEndpoint,
    snapshotMarketId,
    snapshotMode,
    snapshotOracleAddress,
    snapshotWalletAddress,
    wallet.publicKey,
  ]);

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
    const prepared = preparedRef.current;
    if (
      !prepared ||
      !snapshot.currentRawPrice ||
      snapshot.nextPositionNonce === undefined
    ) {
      setError("Instant play is still preparing");
      return;
    }
    setError(null);
    try {
      const result = await openPositionFlow(
        wallet.publicKey,
        direction,
        amount,
        session,
        prepared,
        {
          rawPrice: snapshot.currentRawPrice,
          nextPositionNonce: snapshot.nextPositionNonce,
        },
        (next) => {
          setProgress(next);
          setIntent(next.intent);
        },
      );
      setIntent(result.intent);
      window.setTimeout(() => {
        void Promise.all([refresh(), refreshSession()]);
      }, 250);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Play submission failed");
      setProgress(null);
      const config = readClientLiveConfig();
      const stored = loadOpenIntent(wallet.publicKey.toBase58(), config.marketId);
      setIntent(stored && requiresIntentRecovery(stored) ? stored : null);
    }
  }, [
    refresh,
    refreshSession,
    session,
    setVisible,
    snapshot,
    wallet.publicKey,
  ]);

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
  const statusMessage = claimStatus ?? progress?.message ?? error ?? intent?.message ?? (
    snapshot?.mode === "live" && !wallet.publicKey
      ? "Connect a wallet to play"
      : snapshot?.mode === "live" && !session
        ? "Start a session to play"
        : snapshot?.mode === "live" && !submissionReady
          ? "Preparing instant play…"
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
    submissionReady,
    statusMessage,
  };
}
