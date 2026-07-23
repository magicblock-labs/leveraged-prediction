"use client";

import type { Play, PlayStatus } from "@/app/lib/domain";
import { playStatusAt } from "@/app/lib/domain";

interface YourPlaysProps {
  plays: Play[];
  now: number;
  capacity: number;
  fallbackClaimableUsd?: number;
  claimBusy?: boolean;
  onClaimFallback?(): void;
}

const STATUS_LABELS: Record<PlayStatus, string> = {
  submitting: "Submitting",
  active: "In play",
  settling: "Settling",
  refunding: "Refunding",
  won: "Won",
  lost: "Lost",
  refunded: "Refunded",
};

function contextLine(play: Play, status: PlayStatus, now: number): string {
  const entry = `Entry $${play.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (status === "active") return `${entry} · ${Math.max(0, (play.expiresAt - now) / 1_000).toFixed(1)}s`;
  if (status === "settling") return `${entry} · refund in ${Math.max(0, (play.refundAt - now) / 1_000).toFixed(1)}s`;
  return entry;
}

export function YourPlays({ plays, now, capacity, fallbackClaimableUsd = 0, claimBusy = false, onClaimFallback }: YourPlaysProps) {
  return (
    <section className="positions" aria-label="Your positions">
      <header className="positions-header">
        <h2>Positions</h2>
        <span className="cap num">{Math.min(plays.length, capacity)}/{capacity}</span>
      </header>

      {fallbackClaimableUsd > 0 ? (
        <div className="fallback-payout" aria-label="Protected payout ready">
          <div><span>Protected payout ready</span><strong className="num">${fallbackClaimableUsd.toFixed(2)}</strong></div>
          <button type="button" disabled={claimBusy} onClick={onClaimFallback}>
            {claimBusy ? "Claiming…" : "Claim"}
          </button>
        </div>
      ) : null}

      <div className="plays-list">
        {plays.length === 0 ? (
          <div className="empty-plays">
            <h3>No positions yet</h3>
            <p>Choose an amount, then play up or down.</p>
          </div>
        ) : (
          plays.map((play) => {
            const status = playStatusAt(play, now);
            const finished = status === "won" || status === "lost" || status === "refunded";
            const progress = Math.max(0, Math.min(1, (now - play.openedAt) / (play.expiresAt - play.openedAt)));
            return (
              <article className={`play-row ${play.direction} ${status}`} key={play.id}>
                <div className="chip" aria-hidden="true">{play.direction === "up" ? "▲" : "▼"}</div>
                <div className="what">
                  <strong>{play.direction === "up" ? "Up" : "Down"} · <span className="num">${play.collateralUsd.toFixed(2)}</span> stake</strong>
                  <span className="num">
                    <span className="status-word">{STATUS_LABELS[status]}</span> · {contextLine(play, status, now)}
                  </span>
                  {status === "active" || status === "settling" || status === "refunding" ? (
                    <span className="tbar" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></span>
                  ) : null}
                </div>
                <div className="res num">
                  {finished && play.payoutUsd !== undefined ? (
                    <>
                      <strong>${play.payoutUsd.toFixed(2)}</strong>
                      <span>Payout</span>
                    </>
                  ) : play.estimateUsd !== undefined && !finished ? (
                    <>
                      <strong className={play.estimateUsd >= 0 ? "positive" : "negative"}>
                        {play.estimateUsd >= 0 ? "+" : "−"}${Math.abs(play.estimateUsd).toFixed(2)}
                      </strong>
                      <span>Estimate</span>
                    </>
                  ) : (
                    <strong>—</strong>
                  )}
                  {play.claimableUsd ? <span className="claim-note">Payout ready · ${play.claimableUsd.toFixed(2)}</span> : null}
                </div>
              </article>
            );
          })
        )}
      </div>

      <p className="rail-note">Results stay neutral until settlement is final.</p>
    </section>
  );
}
