"use client";

import { useCallback, useEffect, useState } from "react";

interface InjectedSolanaProvider {
  publicKey?: { toBase58(): string };
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
}

declare global {
  interface Window {
    solana?: InjectedSolanaProvider;
  }
}

export function useInjectedWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let mounted = true;
    const timeout = window.setTimeout(() => {
      const provider = window.solana;
      setAvailable(Boolean(provider));
      if (!provider) return;
      provider
        .connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => {
          if (mounted) setAddress(publicKey.toBase58());
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      mounted = false;
      window.clearTimeout(timeout);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!window.solana) return;
    setConnecting(true);
    try {
      const { publicKey } = await window.solana.connect();
      setAddress(publicKey.toBase58());
    } finally {
      setConnecting(false);
    }
  }, []);

  return { address, available, connecting, connect };
}
