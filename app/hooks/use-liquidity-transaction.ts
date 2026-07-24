"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  addLiquidityFlow,
  completePendingLiquidityWithdrawalFlow,
  removeLiquidityFlow,
  type LiquidityProgress,
} from "@/app/lib/live/transaction-flow";

export function useLiquidityTransaction(
  refresh: () => Promise<void> | void,
) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [progress, setProgress] = useState<LiquidityProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requireWallet = useCallback(() => {
    if (!wallet.publicKey) {
      setVisible(true);
      return null;
    }
    if (!wallet.signTransaction) {
      setError("This wallet must support transaction signing");
      return null;
    }
    return {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction,
    };
  }, [setVisible, wallet.publicKey, wallet.signTransaction]);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setError(null);
    try {
      await operation();
      await refresh();
      window.setTimeout(() => setProgress(null), 1_800);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : "Liquidity transaction failed");
    }
  }, [refresh]);

  const add = useCallback((amount: bigint) => {
    const signer = requireWallet();
    if (!signer) return;
    void run(() =>
      addLiquidityFlow(
        signer.publicKey,
        signer.signTransaction,
        amount,
        setProgress,
      ),
    );
  }, [requireWallet, run]);

  const remove = useCallback((shares: bigint) => {
    const signer = requireWallet();
    if (!signer) return;
    void run(() =>
      removeLiquidityFlow(
        signer.publicKey,
        signer.signTransaction,
        shares,
        setProgress,
      ),
    );
  }, [requireWallet, run]);

  const completePending = useCallback(() => {
    const signer = requireWallet();
    if (!signer) return;
    void run(() =>
      completePendingLiquidityWithdrawalFlow(
        signer.publicKey,
        signer.signTransaction,
        setProgress,
      ),
    );
  }, [requireWallet, run]);

  return {
    add,
    remove,
    completePending,
    busy: progress !== null && progress.phase !== "complete",
    statusMessage: progress?.message ?? error,
    statusTone: error ? "error" as const : "status" as const,
  };
}
