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
    totalUsdc: number;
  };
  errors: string[];
}

type FaucetTone = "success" | "error";

export function useDevnetFaucet(
  walletAddress: string | null,
  refresh: () => Promise<void> | void,
) {
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<FaucetTone>("success");

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
      if (!body.ok) {
        await refresh();
        throw new Error(body.errors.join(" · ") || "One of the test-funds steps failed");
      }
      setMessage(`${body.balances.sol.toFixed(2)} SOL + $${body.balances.totalUsdc.toFixed(2)} test USDC ready`);
      setTone("success");
      await refresh();
      window.setTimeout(() => setMessage(null), 3_500);
    } catch (cause) {
      setTone("error");
      setMessage(cause instanceof Error ? cause.message : "Test-funds request failed");
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, walletAddress]);

  return {
    available: Boolean(info?.enabled),
    busy,
    message,
    tone,
    targetSol: info?.targetSol ?? null,
    targetUsdc: info?.targetUsdc ?? null,
    fund,
  };
}
