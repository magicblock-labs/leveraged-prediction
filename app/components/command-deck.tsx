"use client";

import { useId, useState } from "react";
import type { Direction, MarketSnapshot } from "@/app/lib/domain";

interface CommandDeckProps {
  snapshot: MarketSnapshot;
  occupiedPositions: number;
  busy?: boolean;
  sessionReady?: boolean;
  submissionReady?: boolean;
  sessionAllowanceUsd?: number | null;
  statusMessage?: string | null;
  needsRecovery?: boolean;
  onPlay(direction: Direction, amount: number): void;
  onRecover?(): void;
}

const PRESETS = [5, 10, 25];

export function CommandDeck({ snapshot, occupiedPositions, busy = false, sessionReady = false, submissionReady = false, sessionAllowanceUsd = null, statusMessage, needsRecovery = false, onPlay, onRecover }: CommandDeckProps) {
  const inputId = useId();
  const [amount, setAmount] = useState(10);
  const capacityReached = occupiedPositions >= snapshot.maxPositions;
  const marketCapacityReached = snapshot.activePositions >= snapshot.maxPositions;
  const walletConnected = snapshot.walletAddress !== null;
  const hasBalance = snapshot.walletBalanceUsd !== null && snapshot.walletBalanceUsd >= amount;
  const hasSessionAllowance = sessionReady && sessionAllowanceUsd !== null && sessionAllowanceUsd >= amount;
  const marketBlocked = busy ||
    needsRecovery ||
    snapshot.marketMode !== "open" ||
    capacityReached ||
    marketCapacityReached;
  const activeSessionBlocked = sessionReady &&
    (!walletConnected || !hasSessionAllowance || !submissionReady || !hasBalance);
  const blocked = marketBlocked || activeSessionBlocked;
  const fundingMessage = walletConnected && !hasBalance
    ? snapshot.walletBalanceUsd === null
      ? "USDC account setup is not ready"
      : `You need $${amount.toFixed(2)} USDC to play`
    : sessionReady && !hasSessionAllowance
      ? `Session has $${(sessionAllowanceUsd ?? 0).toFixed(2)} left · choose a smaller play`
    : null;
  const sessionMessage = !sessionReady
    ? walletConnected
      ? "Choose Up or Down to start a one-hour session"
      : "Choose Up or Down to connect and start a session"
    : null;
  const actionMessage = needsRecovery
    ? statusMessage ?? "Check the previous play before sending another one"
    : busy
      ? statusMessage ?? "Finishing the previous play…"
      : snapshot.marketMode !== "open"
      ? "Trading is paused while existing positions settle"
      : sessionMessage ?? fundingMessage ?? statusMessage;

  return (
    <section className="ticket" aria-label="Play controls">
      <div className="field">
        <label htmlFor={inputId}>Play amount</label>
        <div className="stake-row">
          <div className="amount">
            <span aria-hidden="true">$</span>
            <input
              id={inputId}
              type="number"
              min="1"
              max="1000"
              step="1"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(Math.min(1_000, Math.max(1, Number(event.target.value) || 1)))}
            />
          </div>
          <div className="presets" aria-label="Amount presets">
            {PRESETS.map((preset) => (
              <button
                className={`num ${amount === preset ? "is-selected" : ""}`}
                key={preset}
                onClick={() => setAmount(preset)}
                type="button"
              >
                ${preset}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="economics num" aria-live="polite">
        <b>10 sec · 1000× price move</b>
      </p>

      <div className="direction-actions">
        <button
          className="play-button play-up"
          disabled={blocked}
          onClick={() => onPlay("up", amount)}
          type="button"
          title="Price at settlement above entry"
        >
          <span className="direction-icon" aria-hidden="true">▲</span>
          Play up
          <span className="sr-only">— wins if the price at settlement is above entry</span>
        </button>
        <button
          className="play-button play-down"
          disabled={blocked}
          onClick={() => onPlay("down", amount)}
          type="button"
          title="Price at settlement below entry"
        >
          <span className="direction-icon" aria-hidden="true">▼</span>
          Play down
          <span className="sr-only">— wins if the price at settlement is below entry</span>
        </button>
      </div>

      {capacityReached ? <p className="write-lock">{snapshot.maxPositions}/{snapshot.maxPositions} play slots filled · wait for a result</p> : null}
      {!capacityReached && marketCapacityReached ? <p className="write-lock">Market full · {snapshot.maxPositions} active positions</p> : null}
      {!capacityReached && !marketCapacityReached && actionMessage ? (
        <div className="write-lock" role="status">
          <span>{actionMessage}</span>
          {needsRecovery && onRecover ? <button onClick={onRecover} type="button">Check status</button> : null}
        </div>
      ) : null}
    </section>
  );
}
