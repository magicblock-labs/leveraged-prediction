"use client";

import type {
  IndexedPosition,
  LeaderboardEntry,
} from "@/app/lib/indexer/client";
import { formatUsdcMinorUnits } from "@/app/lib/indexer/client";

interface IndexedHistoryProps {
  enabled: boolean;
  status: "disabled" | "loading" | "ready" | "stale" | "unavailable";
  leaderboard: LeaderboardEntry[];
  positions: IndexedPosition[];
  message: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  restartedPagination: boolean;
  onLoadMore(): void;
  onRetry(): void;
}

function compact(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function IndexedHistory({
  enabled,
  status,
  leaderboard,
  positions,
  message,
  hasMore,
  loadingMore,
  restartedPagination,
  onLoadMore,
  onRetry,
}: IndexedHistoryProps) {
  if (!enabled) return null;
  return (
    <section className="indexed-history" aria-label="Completed play history and leaderboard">
      <header>
        <div>
          <span className="eyebrow">Recorded results</span>
          <h2>Leaderboard &amp; history</h2>
        </div>
        {status === "stale" ? <span className="history-state stale">Updating</span> : null}
      </header>

      {status === "unavailable" ? (
        <div className="history-unavailable" role="status">
          <strong>History is temporarily unavailable</strong>
          <span>{message ?? "Live chart, positions, and Up/Down plays still work."}</span>
          <button type="button" onClick={onRetry}>Try history again</button>
        </div>
      ) : (
        <div className="history-grid">
          <div>
            <h3>Top players</h3>
            {status === "loading" ? <p>Loading recorded results…</p> : null}
            {status !== "loading" && leaderboard.length === 0 ? <p>No completed plays yet.</p> : null}
            {leaderboard.map((entry) => (
              <div className="leader-row" key={entry.user}>
                <span className="num">#{entry.rank}</span>
                <strong>{compact(entry.user)}</strong>
                <span className={`num ${entry.net_pnl.startsWith("-") ? "negative" : "positive"}`}>
                  {formatUsdcMinorUnits(entry.net_pnl)}
                </span>
              </div>
            ))}
          </div>
          <div>
            <h3>Your completed plays</h3>
            {status !== "loading" && positions.length === 0 ? <p>Connect a wallet or finish a play to see history.</p> : null}
            {positions.map((position) => (
              <div className="history-row" key={`${position.market_id}:${position.position_id}`}>
                <span aria-hidden="true">{position.direction === "down" ? "▼" : "▲"}</span>
                <strong>{position.outcome ?? position.lifecycle_status}</strong>
                <span className="num">{formatUsdcMinorUnits(position.net_pnl)}</span>
                <small>{position.checkpoint_status === "base_observed" ? "checkpointed" : "ER result"}</small>
              </div>
            ))}
            {hasMore ? (
              <button type="button" className="history-more" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? "Loading…" : "Show more"}
              </button>
            ) : null}
            {restartedPagination ? <p className="history-note">Leaderboard updated, so history restarted from the newest result.</p> : null}
          </div>
        </div>
      )}
    </section>
  );
}
