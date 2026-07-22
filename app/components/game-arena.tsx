"use client";

import { useEffect, useMemo, useState } from "react";
import { CommandDeck } from "@/app/components/command-deck";
import { PriceArena } from "@/app/components/price-arena";
import { YourPlays } from "@/app/components/your-plays";
import { useGameSnapshot } from "@/app/hooks/use-game-snapshot";
import { useGameWallet } from "@/app/hooks/use-game-wallet";
import { usePlayTransaction } from "@/app/hooks/use-play-transaction";
import type { Direction } from "@/app/lib/domain";

function compactAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function GameArena() {
  const wallet = useGameWallet();
  const { snapshot, error, oracleError, refreshing, refresh } = useGameSnapshot(wallet.address);
  const transaction = usePlayTransaction(snapshot, refresh);
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

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div className="loading-mark">↗</div>
        <strong>{error ? "PRICE ARENA OFFLINE" : "LOADING PRICE ARENA"}</strong>
        <p>{error ?? "Preparing the playfield…"}</p>
        {error ? <button onClick={() => void refresh()} type="button">TRY AGAIN</button> : null}
      </main>
    );
  }

  const walletLabel = wallet.address
    ? compactAddress(wallet.address)
    : wallet.available
      ? wallet.connecting ? "CONNECTING…" : "CONNECT WALLET"
      : "WALLET NOT FOUND";

  return (
    <main className="game-shell" data-mode={snapshot.mode}>
      <header className="game-hud">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">↗</span>
          <div><span>MAGICBLOCK ARCADE</span><h1>{snapshot.gameLabel}</h1></div>
        </div>
        <div className="market-block">
          <span className="market-chip">₿</span>
          <div><span>{snapshot.marketLabel}</span><strong>${snapshot.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
          <span className={`feed-pill ${snapshot.feedHealth}`}><i />{snapshot.feedHealth === "live" ? `LIVE · ${snapshot.feedAgeSeconds.toFixed(1)}s` : snapshot.feedHealth.toUpperCase()}</span>
        </div>
        <div className="hud-rule"><span>ROUND</span><strong>10 SECOND PLAYS</strong></div>
        <div className="hud-actions">
          <button className={`icon-button ${feedback ? "is-on" : ""}`} onClick={() => setFeedback((value) => !value)} type="button" aria-label={`${feedback ? "Disable" : "Enable"} haptic feedback`}>{feedback ? "◖))" : "◖×"}</button>
          <button className="help-button" onClick={() => setShowHelp(true)} type="button">? HOW TO PLAY</button>
          <div className="balance-block"><span>PLAY BALANCE</span><strong>{snapshot.walletBalanceUsd === null ? "—" : `$${snapshot.walletBalanceUsd.toFixed(2)}`}</strong></div>
          <button className="wallet-button" onClick={() => void wallet.connect()} disabled={wallet.connecting} type="button"><span className="wallet-led" />{walletLabel}</button>
        </div>
      </header>

      {error ? <div className="system-banner error" role="alert"><strong>LIVE UPDATE PAUSED</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {oracleError ? <div className="system-banner warning" role="status"><strong>REAL-TIME FEED DEGRADED</strong><span>{oracleError} · snapshot fallback remains active</span></div> : null}
      {snapshot.marketMode === "close-only" ? <div className="system-banner warning" role="status"><strong>PLAY PAUSED</strong><span>This market is settling existing positions.</span></div> : null}

      <div className="game-board">
        <div className="arena-column">
          <PriceArena snapshot={snapshot} plays={plays} now={now} />
          <CommandDeck
            snapshot={snapshot}
            occupiedPositions={plays.length}
            busy={transaction.busy}
            statusMessage={transaction.statusMessage}
            needsRecovery={transaction.needsRecovery}
            onRecover={() => void transaction.recover()}
            onPlay={placePlay}
          />
        </div>
        <YourPlays
          plays={plays}
          now={now}
          capacity={snapshot.maxPositions}
          fallbackClaimableUsd={snapshot.fallbackClaimableUsd}
          claimBusy={transaction.claimBusy}
          onClaimFallback={() => void transaction.claimFallback()}
        />
      </div>

      <div className="mode-badge"><span className={refreshing ? "pulse" : ""} />{snapshot.notice}</div>

      {showHelp ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="dialog-close" onClick={() => setShowHelp(false)} type="button" aria-label="Close help">×</button>
            <span className="eyebrow">THREE SIMPLE STEPS</span>
            <h2 id="help-title">How to play</h2>
            <ol>
              <li><strong>Pick an amount.</strong><span>You can lose at most that amount.</span></li>
              <li><strong>Play up or down.</strong><span>Choose where the price will finish after 10 seconds.</span></li>
              <li><strong>Watch Your Plays.</strong><span>At 0.0s the result may still be settling for up to 10 seconds.</span></li>
            </ol>
            <p>Maximum profit is 90% of your play amount after the profit fee. A refund is not a win.</p>
            <button className="dialog-action" onClick={() => setShowHelp(false)} type="button">GOT IT</button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
