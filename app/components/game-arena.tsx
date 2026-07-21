"use client";

import { useEffect, useMemo, useState } from "react";
import { CommandDeck } from "@/app/components/command-deck";
import { PriceArena } from "@/app/components/price-arena";
import { YourPlays } from "@/app/components/your-plays";
import { useGameSnapshot } from "@/app/hooks/use-game-snapshot";
import { useInjectedWallet } from "@/app/hooks/use-injected-wallet";
import type { Direction, Play } from "@/app/lib/domain";

function compactAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function GameArena() {
  const wallet = useInjectedWallet();
  const { snapshot, error, refreshing, refresh } = useGameSnapshot(wallet.address);
  const [clock, setClock] = useState<number | null>(null);
  const [demoPlays, setDemoPlays] = useState<Play[]>([]);
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

  const plays = useMemo(() => [...demoPlays, ...(snapshot?.plays ?? [])], [demoPlays, snapshot?.plays]);

  const placeDemoPlay = (direction: Direction, amount: number) => {
    if (!snapshot || snapshot.mode !== "fixture") return;
    const openedAt = Date.now();
    const play: Play = {
      id: `demo-${openedAt}`,
      marketId: snapshot.marketId,
      direction,
      collateralUsd: amount,
      entryPrice: snapshot.currentPrice,
      openedAt,
      expiresAt: openedAt + 10_000,
      refundAt: openedAt + 20_000,
      status: "active",
      estimateUsd: 0,
    };
    setDemoPlays((current) => [play, ...current].slice(0, 5));
    if (feedback && "vibrate" in navigator) navigator.vibrate(24);
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
    : snapshot.mode === "fixture"
      ? snapshot.walletAddress ?? "DEMO"
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
          <button className="wallet-button" onClick={() => void wallet.connect()} disabled={snapshot.mode === "fixture" || !wallet.available || wallet.connecting} type="button"><span className="wallet-led" />{walletLabel}</button>
        </div>
      </header>

      {error ? <div className="system-banner error" role="alert"><strong>LIVE UPDATE PAUSED</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {snapshot.marketMode === "close-only" ? <div className="system-banner warning" role="status"><strong>PLAY PAUSED</strong><span>This market is settling existing positions.</span></div> : null}

      <div className="game-board">
        <div className="arena-column">
          <PriceArena snapshot={snapshot} plays={plays} now={now} />
          <CommandDeck snapshot={snapshot} occupiedPositions={plays.length} onPlay={placeDemoPlay} />
        </div>
        <YourPlays plays={plays} now={now} capacity={snapshot.maxPositions} />
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
