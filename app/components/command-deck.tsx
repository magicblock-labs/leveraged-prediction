"use client";

import { useId, useState } from "react";
import type { Direction, MarketSnapshot } from "@/app/lib/domain";
import { maximumProfit } from "@/app/lib/domain";

interface CommandDeckProps {
  snapshot: MarketSnapshot;
  occupiedPositions: number;
  onPlay(direction: Direction, amount: number): void;
}

const PRESETS = [5, 10, 25];

export function CommandDeck({ snapshot, occupiedPositions, onPlay }: CommandDeckProps) {
  const inputId = useId();
  const [amount, setAmount] = useState(10);
  const liveReadOnly = snapshot.mode === "live";
  const capacityReached = occupiedPositions >= snapshot.maxPositions;
  const blocked = liveReadOnly || snapshot.marketMode !== "open" || capacityReached;

  return (
    <section className="command-deck" aria-label="Play controls">
      <div className="amount-block">
        <label htmlFor={inputId}>PLAY AMOUNT</label>
        <div className="amount-row">
          <span className="currency-mark">$</span>
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
          <div className="presets" aria-label="Amount presets">
            {PRESETS.map((preset) => (
              <button
                className={amount === preset ? "is-selected" : ""}
                key={preset}
                onClick={() => setAmount(preset)}
                type="button"
              >
                ${preset}
              </button>
            ))}
          </div>
        </div>
        <div className="economics" aria-live="polite">
          <span>10 sec · 1000x sensitivity</span>
          <strong>
            Max <em className="positive">+${maximumProfit(amount).toFixed(2)}</em>
            <i aria-hidden="true">·</i>
            Max <em className="negative">−${amount.toFixed(2)}</em>
          </strong>
        </div>
      </div>

      <div className="direction-actions">
        <button
          className="play-button play-up"
          disabled={blocked}
          onClick={() => onPlay("up", amount)}
          type="button"
        >
          <span className="direction-icon" aria-hidden="true">↗</span>
          <span><small>PRICE FINISHES HIGHER</small>PLAY UP</span>
        </button>
        <button
          className="play-button play-down"
          disabled={blocked}
          onClick={() => onPlay("down", amount)}
          type="button"
        >
          <span className="direction-icon" aria-hidden="true">↘</span>
          <span><small>PRICE FINISHES LOWER</small>PLAY DOWN</span>
        </button>
        {capacityReached ? <p className="write-lock">{snapshot.maxPositions}/{snapshot.maxPositions} play slots filled · wait for a result</p> : null}
        {!capacityReached && liveReadOnly ? <p className="write-lock">Live reads connected · play submission unlocks in the write slice</p> : null}
      </div>
    </section>
  );
}
