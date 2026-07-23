"use client";

import { useId, useState } from "react";

interface SessionGateProps {
  visible: boolean;
  busy: boolean;
  defaultAllowanceUsd: number;
  walletBalanceUsd: number | null;
  status: string | null;
  error: string | null;
  faucetAvailable: boolean;
  faucetBusy: boolean;
  onStart(amountUsd: number): void;
  onFund(): void;
}

export function SessionGate({
  visible,
  busy,
  defaultAllowanceUsd,
  walletBalanceUsd,
  status,
  error,
  faucetAvailable,
  faucetBusy,
  onStart,
  onFund,
}: SessionGateProps) {
  const inputId = useId();
  const [allowance, setAllowance] = useState(defaultAllowanceUsd);
  if (!visible) return null;

  return (
    <div className="session-backdrop">
      <section className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-title">
        <span className="eyebrow">ONE-TIME PLAY SETUP</span>
        <h2 id="session-title">Start your play session</h2>
        <p>
          Choose the most test USDC this one-hour session may spend. Every play then runs instantly
          without another wallet prompt.
        </p>
        <label htmlFor={inputId}>SESSION SPENDING LIMIT</label>
        <div className="session-allowance">
          <span>$</span>
          <input
            id={inputId}
            type="number"
            min="1"
            max="1000"
            step="1"
            inputMode="decimal"
            value={allowance}
            disabled={busy}
            onChange={(event) => setAllowance(
              Math.min(1_000, Math.max(1, Number(event.target.value) || 1)),
            )}
          />
          <small>USDC</small>
        </div>
        <div className="session-balance">
          Available: {walletBalanceUsd === null ? "not funded yet" : `$${walletBalanceUsd.toFixed(2)}`}
        </div>
        {status || error ? (
          <p className={`session-status ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
            {error ?? status}
          </p>
        ) : null}
        <button
          className="session-start"
          disabled={busy}
          onClick={() => onStart(allowance)}
          type="button"
        >
          {busy ? "SETTING UP SESSION…" : `START WITH $${allowance.toFixed(2)} LIMIT`}
        </button>
        {faucetAvailable ? (
          <button
            className="session-fund"
            disabled={busy || faucetBusy}
            onClick={onFund}
            type="button"
          >
            {faucetBusy ? "GETTING TEST FUNDS…" : "GET DEVNET TEST FUNDS"}
          </button>
        ) : null}
        <small className="session-note">
          The session can move up to your selected limit from this test-USDC play balance.
          Liquidity and payout controls remain wallet-only.
        </small>
      </section>
    </div>
  );
}
