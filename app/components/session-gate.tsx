"use client";

import { useId, useState } from "react";
import type { SessionProgress } from "@/app/lib/live/transaction-flow";

type StepState = "pending" | "active" | "complete" | "error";

function sessionStepStates(
  progress: SessionProgress | null,
  error: string | null,
): { base: StepState; er: StepState } {
  const phase = progress?.phase;
  const baseComplete = phase === "approving" || phase === "ready";
  const erComplete = phase === "ready";
  const activeStep = baseComplete ? "er" : "base";

  return {
    base: baseComplete
      ? "complete"
      : error && activeStep === "base"
        ? "error"
        : phase
          ? "active"
          : "pending",
    er: erComplete
      ? "complete"
      : error && activeStep === "er"
        ? "error"
        : phase === "approving"
          ? "active"
          : "pending",
  };
}

function stepStatus(state: StepState): string {
  if (state === "complete") return "Complete";
  if (state === "active") return "In progress";
  if (state === "error") return "Needs attention";
  return "Next";
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
  onDismiss(): void;
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
  onDismiss,
}: SessionGateProps) {
  const inputId = useId();
  const [allowance, setAllowance] = useState(defaultAllowanceUsd);
  if (!visible) return null;
  const steps = sessionStepStates(progress, error);
  const busyLabel = progress?.phase === "approving"
    ? "Step 2 of 2 · Activating…"
    : "Step 1 of 2 · Depositing…";

  return (
    <div
      className="session-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onDismiss();
      }}
    >
      <section
        className="session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          onClick={onDismiss}
          disabled={busy}
          type="button"
          aria-label="Close session setup"
        >
          ×
        </button>
        <span className="eyebrow">One-time play setup</span>
        <h2 id="session-title">
          {hasStoredSession ? "Finish your play session" : "Start your play session"}
        </h2>
        <p>
          {hasStoredSession
            ? "Your setup is saved. Continue the remaining base or arena step."
            : "Choose a one-hour play allowance, then approve one base transaction and one arena transaction."}
        </p>
        <label htmlFor={inputId}>One-hour play allowance</label>
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
        <ol className="session-steps" aria-label="Session setup steps">
          <li className={steps.base}>
            <span className="session-step-number" aria-hidden="true">1</span>
            <span className="session-step-copy">
              <strong>Deposit to arena</strong>
              <small>Base network · Set up your session and deposit test USDC.</small>
            </span>
            <em>{stepStatus(steps.base)}</em>
          </li>
          <li className={steps.er}>
            <span className="session-step-number" aria-hidden="true">2</span>
            <span className="session-step-copy">
              <strong>Activate session</strong>
              <small>MagicBlock ER · Approve one-tap plays for one hour.</small>
            </span>
            <em>{stepStatus(steps.er)}</em>
          </li>
        </ol>
        {walletBalanceUsd === null ? (
          <div className="session-balance-note">
            Buying power appears after your deposit reaches the arena.
          </div>
        ) : (
          <div className="session-balance">
            <span>Arena balance</span>
            <strong className="num">${walletBalanceUsd.toFixed(2)}</strong>
          </div>
        )}
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
            ? busyLabel
            : hasStoredSession
              ? "Continue setup"
              : "Deposit and activate session"}
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
          Two wallet approvals total: everything durable and the deposit happen on base,
          then the play allowance is approved on the ER.
        </small>
      </section>
    </div>
  );
}
