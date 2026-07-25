"use client";

import { BrandMark } from "@/app/components/brand-mark";
import { RouteNav } from "@/app/components/route-nav";
import { SessionIndicator } from "@/app/components/session-indicator";
import { useGameSession } from "@/app/hooks/use-game-session";
import { useGameWallet } from "@/app/hooks/use-game-wallet";
import { useLeaderboard } from "@/app/hooks/use-leaderboard";
import { formatLeaderboardUsdc } from "@/app/lib/leaderboard";

function compactAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}

export function LeaderboardPage() {
  const wallet = useGameWallet();
  const session = useGameSession();
  const leaderboard = useLeaderboard(wallet.address);
  const userStats = leaderboard.userStats;
  const currentWallet = wallet.address;
  const isLoading = leaderboard.status === "loading";
  const statusLabel = {
    disabled: "Indexer pending",
    loading: "Loading",
    ready: "Live",
    stale: "Updating",
    unavailable: "Unavailable",
  }[leaderboard.status];
  const totalVolumeLabel = isLoading
    ? "Loading total volume"
    : leaderboard.totalVolume === null
      ? "Total volume unavailable"
      : `Total volume ${formatLeaderboardUsdc(leaderboard.totalVolume)} USDC`;
  const totalVolumeNote = {
    disabled: "Indexer connection pending",
    loading: "Loading settled test USDC",
    ready: leaderboard.totalVolume === null
      ? "More history is available"
      : "Settled test USDC",
    stale: leaderboard.totalVolume === null
      ? "Refreshing historical data"
      : "Refreshing · settled test USDC",
    unavailable: "Historical data is temporarily unavailable",
  }[leaderboard.status];
  const walletLabel = wallet.address
    ? compactAddress(wallet.address)
    : wallet.available
      ? wallet.connecting ? "Connecting…" : "Connect wallet"
      : "Wallet not found";

  return (
    <main className="app-shell leaderboard-shell">
      <header className="topbar">
        <div className="brand-area">
          <BrandMark />
          <RouteNav active="leaderboard" />
        </div>
        <div className="topbar-actions">
          <SessionIndicator
            active={session.ready}
            checking={session.busy && !session.ready}
            onRequestSetup={() => window.location.assign("/?session=setup")}
          />
          <button
            className="wallet"
            onClick={() => void wallet.connect()}
            disabled={wallet.connecting}
            type="button"
          >
            <span className={`dot ${wallet.address ? "is-connected" : ""}`} />
            <span className="wallet-label">{walletLabel}</span>
          </button>
        </div>
      </header>

      <div className="leaderboard-layout">
        <section className="leaderboard-hero">
          <div className="leaderboard-intro">
            <span className="eyebrow">All-time · settled trades</span>
            <h1>Leaderboard</h1>
            <p>
              See who trades the most, how often they play, and the record
              behind their rank.
            </p>
          </div>
          <div className="total-volume-card">
            <span>Total volume</span>
            <strong className="num" aria-label={totalVolumeLabel}>
              {isLoading
                ? "…"
                : formatLeaderboardUsdc(leaderboard.totalVolume)}
            </strong>
            <small>{totalVolumeNote}</small>
          </div>
        </section>

        <section className="your-ranking" aria-labelledby="your-ranking-title">
          <div className="leaderboard-section-heading">
            <div>
              <h2 id="your-ranking-title">Your performance</h2>
              <p>
                {currentWallet
                  ? userStats?.rank
                    ? `Rank #${userStats.rank} · ${compactAddress(currentWallet)}`
                    : compactAddress(currentWallet)
                  : "Connect your wallet to identify your row."}
              </p>
            </div>
            <span className={`data-state ${leaderboard.status}`}>
              {statusLabel}
            </span>
          </div>
          <dl className="your-ranking-metrics">
            <div>
              <dt>Volume</dt>
              <dd className="num">
                {currentWallet && userStats
                  ? formatLeaderboardUsdc(userStats.volume)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Trades</dt>
              <dd className="num">
                {currentWallet && userStats ? userStats.trades : "—"}
              </dd>
            </div>
            <div>
              <dt>Wins</dt>
              <dd className="num">
                {currentWallet && userStats ? userStats.wins : "—"}
              </dd>
            </div>
            <div>
              <dt>Losses</dt>
              <dd className="num">
                {currentWallet && userStats ? userStats.losses : "—"}
              </dd>
            </div>
          </dl>
          {leaderboard.status === "unavailable" ? (
            <div className="leaderboard-error" role="status">
              <span>{leaderboard.error}</span>
              <button type="button" onClick={leaderboard.retry}>
                Retry
              </button>
            </div>
          ) : null}
        </section>

        <section className="leaderboard-card" aria-labelledby="rankings-title">
          <div className="leaderboard-section-heading">
            <div>
              <h2 id="rankings-title">Rankings</h2>
              <p>Ranked by settled performance.</p>
            </div>
            <span className="leaderboard-period">All time</span>
          </div>
          <div className="leaderboard-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Trader</th>
                  <th scope="col">Volume</th>
                  <th scope="col">Trades</th>
                  <th scope="col">Wins</th>
                  <th scope="col">Losses</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.entries.map((entry) => (
                  <tr
                    className={entry.user === currentWallet ? "is-current" : undefined}
                    key={entry.user}
                  >
                    <td className="num">#{entry.rank}</td>
                    <td>
                      <span className="leaderboard-trader">
                        {compactAddress(entry.user)}
                        {entry.user === currentWallet ? <small>You</small> : null}
                      </span>
                    </td>
                    <td className="num">{formatLeaderboardUsdc(entry.volume)}</td>
                    <td className="num">{entry.trades}</td>
                    <td className="num">{entry.wins}</td>
                    <td className="num">{entry.losses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {leaderboard.entries.length === 0 ? (
              <div className="leaderboard-empty-state">
                <strong>
                  {isLoading ? "Loading rankings…" : "No indexed trades yet"}
                </strong>
                <span>
                  {leaderboard.status === "disabled"
                    ? "Rankings will appear here when the historical indexer is connected."
                    : leaderboard.status === "unavailable"
                      ? "Live trading is unaffected. Try loading the historical data again."
                      : isLoading
                        ? "Reading settled trades from the indexer."
                        : "Settled trades will appear here as the indexer processes them."}
                </span>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
