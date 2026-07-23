"use client";

import { useId, useState } from "react";
import type { SessionProgress } from "@/app/lib/live/transaction-flow";

const SETUP_STEPS = [
  { phase: "creating", label: "Session" },
  { phase: "preparing-accounts", label: "Accounts" },
  { phase: "depositing", label: "Funds" },
  { phase: "preparing-fee-payer", label: "Fees" },
  { phase: "approving", label: "Approval" },
] as const;

function activeStepIndex(progress: SessionProgress | null, hasStoredSession: boolean): number {
  if (progress?.phase === "ready") return SETUP_STEPS.length;
  if (!progress) return hasStoredSession ? 1 : 0;
  return SETUP_STEPS.findIndex((step) => step.phase === progress.phase);
}

interface SessionGateProps {
  visible: boolean;
  busy: boolean;
  defaultAllowanceUsd: number;
  walletBalanceUsd: number | null;
  progress: SessionProgress | null;
  hasStoredSession: boolean;
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
  progress,
  hasStoredSession,
  error,
  faucetAvailable,
  faucetBusy,
  onStart,
  onFund,
}: SessionGateProps) {
  const inputId = useId();
  const [allowance, setAllowance] = useState(defaultAllowanceUsd);
  if (!visible) return null;
  const currentStep = activeStepIndex(progress, hasStoredSession);

  return (
    <div className="session-backdrop">
      <section className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-title">
        <span className="eyebrow">One-time play setup</span>
        <h2 id="session-title">
          {hasStoredSession ? "Finish your play session" : "Start your play session"}
        </h2>
        <p>
          {hasStoredSession
            ? "Your session is already created. Continue the remaining setup without creating another one."
            : "Choose the most test USDC this one-hour session may spend. Every play then runs instantly without another wallet prompt."}
        </p>
        <ol className="session-stepper" aria-label="Session setup progress">
          {SETUP_STEPS.map((step, index) => {
            const complete = index < currentStep;
            const active = index === currentStep;
            return (
              <li
                className={complete ? "complete" : active ? "active" : ""}
                aria-current={active ? "step" : undefined}
                key={step.phase}
              >
                <span aria-hidden="true">{complete ? "✓" : index + 1}</span>
                <small>{step.label}</small>
              </li>
            );
          })}
        </ol>
        <label htmlFor={inputId}>Session spending limit</label>
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
        {progress || error ? (
          <p className={`session-status ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
            {error ?? progress?.message}
          </p>
        ) : null}
        <button
          className="session-start"
          disabled={busy}
          onClick={() => onStart(allowance)}
          type="button"
        >
          {busy
            ? "Setting up session…"
            : hasStoredSession
              ? "Continue setup"
              : `Start with a $${allowance.toFixed(2)} limit`}
        </button>
        {faucetAvailable ? (
          <button
            className="session-fund"
            disabled={busy || faucetBusy}
            onClick={onFund}
            type="button"
          >
            {faucetBusy ? "Getting test funds…" : "Get devnet test funds"}
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
