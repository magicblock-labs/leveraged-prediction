"use client";

import { useEffect, useMemo, useState } from "react";
import { CommandDeck } from "@/app/components/command-deck";
import { PriceArena } from "@/app/components/price-arena";
import { YourPlays } from "@/app/components/your-plays";
import { SessionGate } from "@/app/components/session-gate";
import { RouteNav } from "@/app/components/route-nav";
import { IndexedHistory } from "@/app/components/indexed-history";
import { useGameSnapshot } from "@/app/hooks/use-game-snapshot";
import { useGameWallet } from "@/app/hooks/use-game-wallet";
import { useGameSession } from "@/app/hooks/use-game-session";
import { usePlayTransaction } from "@/app/hooks/use-play-transaction";
import { useDevnetFaucet } from "@/app/hooks/use-devnet-faucet";
import { useIndexedHistory } from "@/app/hooks/use-indexed-history";
import type { Direction } from "@/app/lib/domain";

function compactAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function GameArena() {
  const wallet = useGameWallet();
  const { snapshot, error, oracleError, marketError, positionError, refreshing, refresh } = useGameSnapshot(wallet.address);
  const session = useGameSession();
  const transaction = usePlayTransaction(snapshot, refresh, session.session, session.refresh);
  const faucet = useDevnetFaucet(wallet.address, refresh);
  const indexed = useIndexedHistory(wallet.address, snapshot?.marketId ?? null);
  const [clock, setClock] = useState<number | null>(null);
  const [feedback, setFeedback] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const tick = () => setClock(Date.now());
    const timeout = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 100);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, []);

  const now = clock ?? snapshot?.capturedAt ?? 0;

  const plays = useMemo(
    () => [
      ...(transaction.pendingPlay ? [transaction.pendingPlay] : []),
      ...(snapshot?.plays ?? []),
    ],
    [snapshot?.plays, transaction.pendingPlay],
  );

  const placePlay = (direction: Direction, amount: number) => {
    if (feedback && "vibrate" in navigator) navigator.vibrate(24);
    void transaction.submit(direction, amount);
  };

  const requestTestFunds = () => {
    if (!wallet.address) {
      void wallet.connect();
      return;
    }
    void faucet.fund();
  };

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div className="loading-mark">lever</div>
        <strong>{error ? "Live market unavailable" : "Loading market"}</strong>
        <p>{error ?? "Connecting to the live price feed…"}</p>
        {error ? <button onClick={() => void refresh()} type="button">Try again</button> : null}
      </main>
    );
  }

  const walletLabel = wallet.address
    ? compactAddress(wallet.address)
    : wallet.available
      ? wallet.connecting ? "Connecting…" : "Connect wallet"
      : "Wallet not found";

  const windowOpen = snapshot.priceHistory[0]?.price;
  const change = windowOpen !== undefined ? snapshot.currentPrice - windowOpen : null;
  const changePct = windowOpen ? Math.abs(((snapshot.currentPrice - windowOpen) / windowOpen) * 100) : 0;

  return (
    <main className="app-shell" data-mode={snapshot.mode}>
      <header className="topbar">
        <div className="brand-area">
          <div className="mark">lever</div>
          <RouteNav active="trade" />
        </div>
        <div className="topbar-actions">
          <button
            className={`quiet-button feedback-toggle ${feedback ? "is-on" : ""}`}
            onClick={() => setFeedback((value) => !value)}
            type="button"
            aria-label={`${feedback ? "Disable" : "Enable"} haptic feedback`}
          >
            {feedback ? "Haptics on" : "Haptics off"}
          </button>
          <button className="quiet-button help-toggle" onClick={() => setShowHelp(true)} type="button">
            How to play
          </button>
          {faucet.available ? (
            <button
              className="quiet-button"
              disabled={faucet.busy}
              onClick={requestTestFunds}
              type="button"
              title={faucet.targetSol !== null && faucet.targetUsdc !== null ? `Top up to ${faucet.targetSol} devnet SOL and $${faucet.targetUsdc} test USDC` : "Get devnet test funds"}
            >
              {faucet.busy ? "Funding…" : "Get test funds"}
            </button>
          ) : null}
          {wallet.address && session.ready ? (
            <div className="stat-block" title="One-hour session spending allowance remaining">
              <span>Session limit</span>
              <strong className="num">${session.remainingAllowanceUsd?.toFixed(2)}</strong>
            </div>
          ) : null}
          <div className="stat-block">
            <span>Buying power</span>
            <strong className="num">{snapshot.walletBalanceUsd === null ? "—" : `$${snapshot.walletBalanceUsd.toFixed(2)}`}</strong>
          </div>
          <button className="wallet" onClick={() => void wallet.connect()} disabled={wallet.connecting} type="button">
            <span className={`dot ${wallet.address ? "is-connected" : ""}`} />
            {walletLabel}
          </button>
        </div>
      </header>

      {error ? <div className="system-banner error" role="alert"><strong>Live updates paused</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {oracleError ? <div className="system-banner warning" role="status"><strong>Price stream degraded</strong><span>{oracleError} · snapshot fallback remains active</span></div> : null}
      {marketError ? <div className="system-banner warning" role="status"><strong>Arena updates degraded</strong><span>{marketError} · snapshot fallback remains active</span></div> : null}
      {positionError ? <div className="system-banner warning" role="status"><strong>Position updates degraded</strong><span>{positionError} · snapshot fallback remains active</span></div> : null}
      {snapshot.marketMode === "close-only" ? <div className="system-banner warning" role="status"><strong>Trading paused</strong><span>This market is settling existing positions.</span></div> : null}
      {faucet.message ? <div className={`faucet-toast ${faucet.tone}`} role={faucet.tone === "error" ? "alert" : "status"}>{faucet.message}</div> : null}

      <div className="col">
        <div className="stage">
          <section className="quote">
            <div className="quote-top">
              <span className="eyebrow">{snapshot.marketLabel}</span>
              <span className={`feed-pill ${snapshot.feedHealth}`}>
                <i aria-hidden="true" />
                {snapshot.feedHealth === "live"
                  ? `Live · ${snapshot.feedAgeSeconds.toFixed(1)}s`
                  : snapshot.feedHealth === "delayed"
                    ? `Delayed · last update ${snapshot.feedAgeSeconds.toFixed(0)}s ago`
                    : "Offline"}
              </span>
            </div>
            <h1 className="num">${snapshot.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</h1>
            {change !== null ? (
              <span className={`chg num ${change >= 0 ? "positive" : "negative"}`}>
                {change >= 0 ? "▲" : "▼"} ${Math.abs(change).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({changePct.toFixed(3)}%) · last 40s
              </span>
            ) : (
              <span className="chg">10-second plays · 1000× sensitivity</span>
            )}
          </section>
          <PriceArena snapshot={snapshot} plays={plays} now={now} />
        </div>

        <aside className="rail">
          <CommandDeck
            snapshot={snapshot}
            occupiedPositions={plays.length}
            busy={transaction.busy}
            sessionReady={session.ready}
            submissionReady={transaction.submissionReady}
            sessionAllowanceUsd={session.remainingAllowanceUsd}
            statusMessage={transaction.statusMessage}
            needsRecovery={transaction.needsRecovery}
            onRecover={() => void transaction.recover()}
            onPlay={placePlay}
          />
          <YourPlays
            plays={plays}
            now={now}
            capacity={snapshot.maxPositions}
            fallbackClaimableUsd={snapshot.fallbackClaimableUsd}
            claimBusy={transaction.claimBusy}
            onClaimFallback={() => void transaction.claimFallback()}
          />
        </aside>
      </div>

      <IndexedHistory
        enabled={indexed.status !== "disabled"}
        status={indexed.status}
        leaderboard={indexed.leaderboard}
        positions={indexed.positions}
        message={indexed.message}
        hasMore={Boolean(indexed.positionMeta?.next_cursor)}
        loadingMore={indexed.loadingMore}
        restartedPagination={indexed.restartedPagination}
        onLoadMore={indexed.loadMore}
        onRetry={indexed.retry}
      />

      <div className="mode-badge"><span className={refreshing ? "pulse" : ""} />{snapshot.notice}</div>

      <SessionGate
        key={session.session?.sessionToken ?? "new-session"}
        visible={Boolean(wallet.address) && !session.ready}
        busy={session.busy}
        defaultAllowanceUsd={session.defaultAllowanceUsd}
        walletBalanceUsd={snapshot.walletBalanceUsd}
        progress={session.progress}
        hasStoredSession={session.hasStoredSession}
        error={session.error}
        faucetAvailable={faucet.available}
        faucetBusy={faucet.busy}
        onStart={(amount) => void session.start(amount)}
        onFund={requestTestFunds}
      />

      {showHelp ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="dialog-close" onClick={() => setShowHelp(false)} type="button" aria-label="Close help">×</button>
            <span className="eyebrow">Three simple steps</span>
            <h2 id="help-title">How to play</h2>
            <ol>
              <li><strong>Pick an amount.</strong><span>You can lose at most that amount.</span></li>
              <li><strong>Play up or down.</strong><span>Choose where the price will finish after 10 seconds.</span></li>
              <li><strong>Watch your positions.</strong><span>At 0.0s the result may still be settling for up to 10 seconds.</span></li>
            </ol>
            <p>Profit follows the favorable price move ×1000, capped at 5× your stake before the 10% profit fee. A refund is not a win.</p>
            <button className="dialog-action" onClick={() => setShowHelp(false)} type="button">Got it</button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
