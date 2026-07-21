"use client";

import type { Play } from "@/app/lib/domain";
import { playStatusAt } from "@/app/lib/domain";

interface YourPlaysProps {
  plays: Play[];
  now: number;
  capacity: number;
}

function statusLabel(play: Play, now: number): string {
  const status = playStatusAt(play, now);
  if (status === "active") return "IN PLAY";
  if (status === "settling") return "SETTLING";
  if (status === "refunding") return "REFUNDING";
  if (status === "won") return "RESULT · WON";
  if (status === "lost") return "RESULT · LOST";
  if (status === "refunded") return "REFUNDED";
  return "SUBMITTING";
}

function primaryValue(play: Play, now: number): string {
  const status = playStatusAt(play, now);
  if (status === "active") return `${Math.max(0, (play.expiresAt - now) / 1_000).toFixed(1)}s`;
  if (status === "settling") return `${Math.max(0, (play.refundAt - now) / 1_000).toFixed(1)}s`;
  if (play.payoutUsd !== undefined) return `$${play.payoutUsd.toFixed(2)}`;
  return "—";
}

export function YourPlays({ plays, now, capacity }: YourPlaysProps) {
  return (
    <aside className="plays-rail" aria-label="Your plays">
      <header className="rail-header">
        <div><span className="eyebrow">LIVE BOARD</span><h2>YOUR PLAYS</h2></div>
        <strong>{Math.min(plays.length, capacity)}<span>/{capacity}</span></strong>
      </header>

      <div className="plays-list">
        {plays.length === 0 ? (
          <div className="empty-plays">
            <span aria-hidden="true">◎</span>
            <h3>No plays yet</h3>
            <p>Choose an amount, then play up or down.</p>
          </div>
        ) : (
          plays.map((play) => {
            const status = playStatusAt(play, now);
            const progress = Math.max(0, Math.min(1, (now - play.openedAt) / (play.expiresAt - play.openedAt)));
            return (
              <article className={`play-card ${play.direction} ${status}`} key={play.id}>
                <div className="play-card-top">
                  <span className="direction-badge" aria-label={`${play.direction} play`}>
                    {play.direction === "up" ? "↗" : "↘"}
                  </span>
                  <div className="play-name">
                    <strong>{play.direction.toUpperCase()} · BTC/USD</strong>
                    <span>${play.collateralUsd.toFixed(2)} PLAY</span>
                  </div>
                  <strong className="play-timer">{primaryValue(play, now)}</strong>
                </div>
                <div className="entry-row">
                  <span>Entry <strong>${play.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
                  {play.estimateUsd !== undefined && status !== "won" && status !== "lost" ? (
                    <span>Estimate <strong className={play.estimateUsd >= 0 ? "positive" : "negative"}>{play.estimateUsd >= 0 ? "+" : "−"}${Math.abs(play.estimateUsd).toFixed(2)}</strong></span>
                  ) : null}
                </div>
                <div className="play-progress" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
                <div className="play-card-bottom">
                  <span className="status-label">{statusLabel(play, now)}</span>
                  {play.claimableUsd ? <button type="button" disabled title="Claim wiring is part of the write slice">PAYOUT READY · ${play.claimableUsd.toFixed(2)}</button> : <span>10 SECOND PLAY</span>}
                </div>
              </article>
            );
          })
        )}
      </div>

      <footer className="rail-footer"><span className="safety-dot" /> Results stay neutral until settlement is final</footer>
    </aside>
  );
}
