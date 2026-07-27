"use client";

import type { CSSProperties } from "react";
import type { Play, PlayStatus } from "@/app/lib/domain";
import { playStatusAt } from "@/app/lib/domain";
import {
  positionProfitUsd,
  positionWatchState,
} from "@/app/lib/position-presentation";

interface YourPlaysProps {
  plays: Play[];
  now: number;
  celebratingIds?: ReadonlySet<string>;
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
  breakeven: "Draw",
  refunded: "Refunded",
};

function contextLine(play: Play, status: PlayStatus, now: number): string {
  const entry = `Entry $${play.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (status === "settling") return `${entry} · refund in ${Math.max(0, (play.refundAt - now) / 1_000).toFixed(1)}s`;
  return entry;
}

const MOMENTUM_LABELS = {
  ahead: "You’re ahead",
  chasing: "Chasing",
  level: "On the line",
} as const;

export function YourPlays({ plays, now, celebratingIds, fallbackClaimableUsd = 0, claimBusy = false, onClaimFallback }: YourPlaysProps) {
  return (
    <section className="positions" aria-label="Your positions">
      <header className="positions-header">
        <h2>Positions</h2>
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
            const watch = positionWatchState(play, now);
            const finished = status === "won" || status === "lost" || status === "breakeven" || status === "refunded";
            const isActive = status === "active";
            const profit = finished ? positionProfitUsd(play) : null;
            const profitTone =
              profit === null || profit === 0
                ? ""
                : profit > 0
                  ? "positive"
                  : "negative";
            return (
              <article
                className={[
                  "play-row",
                  play.direction,
                  status,
                  isActive ? `is-watching is-${watch.result}` : "",
                  watch.isFinalSeconds ? "is-final-seconds" : "",
                  celebratingIds?.has(play.id) ? "is-celebrating" : "",
                ].filter(Boolean).join(" ")}
                key={play.id}
              >
                {isActive ? (
                  <div
                    className="live-countdown num"
                    style={{
                      "--round-progress": `${watch.progress * 360}deg`,
                    } as CSSProperties}
                    aria-label={`${watch.remainingSeconds.toFixed(1)} seconds remaining`}
                  >
                    <strong>{watch.remainingSeconds.toFixed(1)}</strong>
                    <span>sec</span>
                  </div>
                ) : (
                  <div className="chip" aria-hidden="true">{play.direction === "up" ? "▲" : "▼"}</div>
                )}
                <div className="what">
                  {isActive ? (
                    <>
                      <div className="live-play-title">
                        <strong>
                          {play.direction === "up" ? "▲ Up" : "▼ Down"} ·{" "}
                          <span className="num">${play.collateralUsd.toFixed(2)}</span>
                        </strong>
                        <span className="live-round-badge"><i aria-hidden="true" /> Live</span>
                      </div>
                      <span className={`play-momentum ${watch.result}`}>
                        {MOMENTUM_LABELS[watch.result]}
                      </span>
                      <span className="finish-line num">{watch.finishLabel}</span>
                      <span className="tbar live-tbar" aria-hidden="true">
                        <span style={{ width: `${watch.progress * 100}%` }} />
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>{play.direction === "up" ? "Up" : "Down"} · <span className="num">${play.collateralUsd.toFixed(2)}</span> stake</strong>
                      <span className="num">
                        <span className="status-word">{STATUS_LABELS[status]}</span> · {contextLine(play, status, now)}
                      </span>
                    </>
                  )}
                  {status === "settling" || status === "refunding" ? (
                    <span className="tbar" aria-hidden="true"><span style={{ width: "100%" }} /></span>
                  ) : null}
                </div>
                <div className="res num">
                  {finished && profit !== null ? (
                    <>
                      <strong className={profitTone}>
                        {profit > 0 ? "+" : profit < 0 ? "−" : ""}$
                        {Math.abs(profit).toFixed(2)}
                      </strong>
                      <span className={profitTone}>Net profit</span>
                    </>
                  ) : play.priceMovePercent !== undefined && play.liveProfitUsd !== undefined && !finished ? (
                    <>
                      <strong className={`live-move ${play.priceMovePercent >= 0 ? "positive" : "negative"}`}>
                        {play.priceMovePercent >= 0 ? "+" : "−"}{Math.abs(play.priceMovePercent).toFixed(3)}%
                      </strong>
                      <span className={`live-pnl ${play.liveProfitUsd >= 0 ? "positive" : "negative"}`}>
                        {play.liveProfitUsd >= 0 ? "+" : "−"}${Math.abs(play.liveProfitUsd).toFixed(2)}{" "}live P&amp;L
                      </span>
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
