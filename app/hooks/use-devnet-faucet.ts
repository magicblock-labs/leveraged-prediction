"use client";

import { useCallback, useEffect, useState } from "react";

interface FaucetInfo {
  enabled: boolean;
  targetSol: number;
  targetUsdc: number;
}

interface FaucetResult extends FaucetInfo {
  ok: boolean;
  balances: {
    sol: number;
    baseUsdc: number;
    erUsdc: number;
    arenaUsdc: number | null;
    totalUsdc: number;
  };
  added: {
    sol: number;
    usdc: number;
  };
  failures: {
    sol: string | null;
    usdc: string | null;
  };
  errors: string[];
}

type FaucetTone = "success" | "warning" | "error";

export const SOLANA_DEVNET_FAUCET_URL = "https://faucet.solana.com/";

export function devnetFaucetSuccessMessage(result: FaucetResult): string {
  const additions = [
    result.added.usdc > 0
      ? `$${result.added.usdc.toFixed(2)} test USDC added`
      : null,
    result.added.sol > 0
      ? `${result.added.sol.toFixed(2)} SOL added`
      : null,
  ].filter((part): part is string => part !== null);

  if (additions.length > 0) {
    const destination = result.balances.arenaUsdc === null
      ? "deposit to arena to use it"
      : `$${result.balances.arenaUsdc.toFixed(2)} arena balance`;
    return `${additions.join(" + ")} · ${destination}`;
  }
  return result.balances.arenaUsdc === null
    ? "Test funds ready · deposit to arena to see buying power"
    : `Already funded · $${result.balances.arenaUsdc.toFixed(2)} arena balance`;
}

export function devnetFaucetSolFailureMessage(result: FaucetResult): string {
  const usdcOutcome = result.added.usdc > 0
    ? `$${result.added.usdc.toFixed(2)} test USDC minted`
    : result.balances.arenaUsdc === null
      ? "test USDC is ready to deposit"
      : `$${result.balances.arenaUsdc.toFixed(2)} arena balance is ready`;
  return `SOL airdrop failed · ${usdcOutcome}`;
}

export function isSolOnlyFaucetFailure(result: FaucetResult): boolean {
  return Boolean(result.failures.sol && !result.failures.usdc);
}

export function useDevnetFaucet(
  walletAddress: string | null,
  refresh: () => Promise<void> | void,
  onBalanceReady?: (balanceUsd: number | null) => void,
) {
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<FaucetTone>("success");
  const [actionUrl, setActionUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/devnet-faucet", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as FaucetInfo;
        if (active && response.ok) setInfo(body);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const fund = useCallback(async () => {
    if (!walletAddress || busy) return;
    setBusy(true);
    setMessage("Requesting devnet SOL and test USDC…");
    setTone("success");
    setActionUrl(null);
    try {
      const response = await fetch("/api/devnet-faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: walletAddress }),
      });
      const body = await response.json() as FaucetResult | { error?: string };
      if (!("balances" in body)) {
        throw new Error("error" in body && body.error ? body.error : `Test funds failed (${response.status})`);
      }
      onBalanceReady?.(body.balances.arenaUsdc);
      if (isSolOnlyFaucetFailure(body)) {
        setMessage(devnetFaucetSolFailureMessage(body));
        setTone("warning");
        setActionUrl(SOLANA_DEVNET_FAUCET_URL);
        await refresh();
        window.setTimeout(() => {
          setMessage(null);
          setActionUrl(null);
        }, 12_000);
        return;
      }
      if (!body.ok) {
        await refresh();
        throw new Error(body.errors.join(" · ") || "One of the test-funds steps failed");
      }
      setMessage(devnetFaucetSuccessMessage(body));
      setTone("success");
      await refresh();
      window.setTimeout(() => setMessage(null), 3_500);
    } catch (cause) {
      setTone("error");
      setActionUrl(null);
      setMessage(cause instanceof Error ? cause.message : "Test-funds request failed");
    } finally {
      setBusy(false);
    }
  }, [busy, onBalanceReady, refresh, walletAddress]);

  return {
    available: Boolean(info?.enabled),
    busy,
    message,
    tone,
    actionUrl,
    targetSol: info?.targetSol ?? null,
    targetUsdc: info?.targetUsdc ?? null,
    fund,
  };
}
