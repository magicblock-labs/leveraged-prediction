"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

export function useGameWallet() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();

  const connect = useCallback(async () => {
    if (!wallet.wallet) {
      setVisible(true);
      return;
    }
    await wallet.connect();
  }, [setVisible, wallet]);

  return {
    ...wallet,
    address: wallet.publicKey?.toBase58() ?? null,
    available: wallet.wallets.length > 0,
    connect,
    openWalletModal: () => setVisible(true),
  };
}
