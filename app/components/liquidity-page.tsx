"use client";

import { useCallback, useMemo, useState } from "react";
import { BrandMark } from "@/app/components/brand-mark";
import { RouteNav } from "@/app/components/route-nav";
import { SessionIndicator } from "@/app/components/session-indicator";
import { useGameSession } from "@/app/hooks/use-game-session";
import { useGameWallet } from "@/app/hooks/use-game-wallet";
import { useLiquidityIndexer } from "@/app/hooks/use-liquidity-indexer";
import { useLiquiditySnapshot } from "@/app/hooks/use-liquidity-snapshot";
import { useLiquidityTransaction } from "@/app/hooks/use-liquidity-transaction";
import {
  assetsForShares,
  formatShares,
  formatUsdcMinor,
  maximumRemovableShares,
  parseUsdcInput,
  sharesForAssetsRoundUp,
  sharesForDeposit,
} from "@/app/lib/liquidity";

type LiquidityAction = "add" | "remove";

function compactAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}

function inputValueForMinor(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

function ownershipPercent(shares: bigint, totalShares: bigint): string {
  if (shares <= 0n || totalShares <= 0n) return "0.0000%";
  const scaled = shares * 1_000_000n / totalShares;
  return `${(Number(scaled) / 10_000).toFixed(4)}%`;
}

export function LiquidityPage() {
  const wallet = useGameWallet();
  const session = useGameSession();
  const { snapshot, error, refreshing, refresh } =
    useLiquiditySnapshot(wallet.address);
  const indexer = useLiquidityIndexer(
    wallet.address,
    snapshot?.marketId ?? null,
  );
  const refreshIndexer = indexer.refresh;
  const refreshAll = useCallback(async () => {
    refreshIndexer();
    await refresh();
  }, [refresh, refreshIndexer]);
  const transaction = useLiquidityTransaction(refreshAll);
  const [action, setAction] = useState<LiquidityAction>("add");
  const [amount, setAmount] = useState("");
  const [removeSharesOverride, setRemoveSharesOverride] =
    useState<bigint | null>(null);

  const values = useMemo(() => {
    if (!snapshot) return null;
    const livePoolBalance = BigInt(snapshot.poolBalanceMinor);
    const liveTotalShares = BigInt(snapshot.totalShares);
    const indexedMarketReady = indexer.status === "ready";
    const indexedQuoteReady = indexer.status === "ready" &&
      indexer.market.poolBalanceMinor !== null &&
      indexer.market.totalShares !== null;
    const poolBalance = BigInt(
      indexedMarketReady && indexer.market.poolBalanceMinor !== null
        ? indexer.market.poolBalanceMinor!
        : livePoolBalance,
    );
    const totalShares = BigInt(
      indexedMarketReady && indexer.market.totalShares !== null
        ? indexer.market.totalShares!
        : liveTotalShares,
    );
    const quotePoolBalance = indexedQuoteReady
      ? poolBalance
      : livePoolBalance;
    const quoteTotalShares = indexedQuoteReady
      ? totalShares
      : liveTotalShares;
    const userShares = BigInt(snapshot.userShares);
    const currentValue = assetsForShares(
      userShares,
      quotePoolBalance,
      quoteTotalShares,
    );
    const pendingShares = BigInt(snapshot.pendingWithdrawalShares);
    const deposited = indexer.depositedMinor === null
      ? null
      : BigInt(indexer.depositedMinor);
    const indexedShares = indexer.indexedShares === null
      ? null
      : BigInt(indexer.indexedShares);
    const walletBalance = snapshot.walletBalanceMinor === null
      ? null
      : BigInt(snapshot.walletBalanceMinor);
    const marketMode = indexer.status === "ready"
      ? indexer.market.marketMode ?? snapshot.marketMode
      : snapshot.marketMode;
    const activePositions = indexer.status === "ready"
      ? indexer.market.activePositions ?? snapshot.activePositions
      : snapshot.activePositions;
    const inputMinor = parseUsdcInput(amount);
    const maxRemovableShares = maximumRemovableShares(
      userShares,
      quotePoolBalance,
      quoteTotalShares,
      marketMode,
    );
    const requestedRemoveShares = action === "remove" && inputMinor
      ? removeSharesOverride ??
        sharesForAssetsRoundUp(
          inputMinor,
          quotePoolBalance,
          quoteTotalShares,
        )
      : 0n;
    const expectedRemoveAssets = assetsForShares(
      requestedRemoveShares,
      quotePoolBalance,
      quoteTotalShares,
    );
    return {
      poolBalance,
      totalShares,
      userShares,
      currentValue,
      pendingShares,
      deposited,
      depositedIsCurrent: indexedShares === userShares,
      walletBalance,
      marketMode,
      activePositions,
      inputMinor,
      maxRemovableShares,
      requestedRemoveShares,
      expectedRemoveAssets,
      estimatedAddShares: inputMinor
        ? sharesForDeposit(
            inputMinor,
            quotePoolBalance,
            quoteTotalShares,
          )
        : 0n,
    };
  }, [
    action,
    amount,
    indexer.depositedMinor,
    indexer.indexedShares,
    indexer.market,
    indexer.status,
    removeSharesOverride,
    snapshot,
  ]);

  if (!snapshot || !values) {
    return (
      <main className="loading-screen">
        <div className="loading-mark">lever</div>
        <strong>{error ? "Liquidity unavailable" : "Loading liquidity"}</strong>
        <p>{error ?? "Reading the market pool and your shares…"}</p>
        {error ? (
          <button onClick={() => void refresh()} type="button">Try again</button>
        ) : null}
      </main>
    );
  }

  const connected = Boolean(wallet.address);
  const marketHasRisk = values.activePositions > 0;
  const pending = values.pendingShares > 0n;
  const addInvalid = !values.inputMinor ||
    values.estimatedAddShares <= 0n ||
    (values.walletBalance !== null && values.inputMinor > values.walletBalance);
  const removeInvalid = !values.inputMinor ||
    values.requestedRemoveShares <= 0n ||
    values.requestedRemoveShares > values.maxRemovableShares;
  const actionDisabled = transaction.busy ||
    !connected ||
    marketHasRisk ||
    pending ||
    (action === "add"
      ? values.marketMode !== "open" || addInvalid
      : removeInvalid);
  const walletLabel = wallet.address
    ? compactAddress(wallet.address)
    : wallet.available
      ? wallet.connecting ? "Connecting…" : "Connect wallet"
      : "Wallet not found";

  const chooseAction = (next: LiquidityAction) => {
    setAction(next);
    setAmount("");
    setRemoveSharesOverride(null);
  };

  const chooseRemoval = (percentage: bigint) => {
    const shares = values.maxRemovableShares * percentage / 100n;
    const assets = assetsForShares(
      shares,
      values.poolBalance,
      values.totalShares,
    );
    setRemoveSharesOverride(shares);
    setAmount(inputValueForMinor(assets));
  };

  const submit = () => {
    if (actionDisabled || !values.inputMinor) return;
    if (action === "add") {
      transaction.add(values.inputMinor);
    } else {
      transaction.remove(values.requestedRemoveShares);
    }
  };

  const marketStatus = marketHasRisk
    ? "Positions settling"
    : values.marketMode === "close-only"
      ? "Deposits paused"
      : "Available";
  const indexerLoading = indexer.status === "loading";
  const indexerAvailable =
    indexer.status === "ready" || indexer.status === "stale";
  const depositedLabel = !connected
    ? "—"
    : values.deposited !== null && values.depositedIsCurrent
      ? `$${formatUsdcMinor(values.deposited)}`
      : indexerLoading
        ? "Loading…"
        : "Syncing";
  const depositedNote = !connected
    ? "Connect wallet for indexed history"
    : values.deposited !== null && values.depositedIsCurrent
      ? indexer.status === "stale"
        ? "Cost basis · indexer updating"
        : "Remaining indexed cost basis"
      : indexerAvailable
        ? "Waiting for indexed share history"
        : "History temporarily unavailable";
  const syncLabel = refreshing || indexerLoading
    ? "Updating"
    : indexer.status === "ready"
      ? "Contract + API"
      : indexer.status === "stale"
        ? "API updating"
        : "Contract live";

  return (
    <main className="app-shell liquidity-shell">
      <header className="topbar">
        <div className="brand-area">
          <BrandMark />
          <RouteNav active="liquidity" />
        </div>
        <div className="topbar-actions">
          <SessionIndicator
            active={session.ready}
            checking={session.busy && !session.ready}
            onRequestSetup={() => window.location.assign("/?session=setup")}
          />
          <div className="stat-block">
            <span>Wallet balance</span>
            <strong className="num">
              {values.walletBalance === null
                ? "—"
                : `$${formatUsdcMinor(values.walletBalance)}`}
            </strong>
          </div>
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

      {error ? (
        <div className="system-banner warning" role="status">
          <strong>Updates paused</strong>
          <span>{error}</span>
          <button onClick={() => void refresh()} type="button">Retry</button>
        </div>
      ) : null}

      <div className="liquidity-layout">
        <section className="liquidity-intro">
          <span className="eyebrow">{snapshot.marketLabel} market</span>
          <h1>Provide liquidity</h1>
          <p>
            Back every play in this market. Your share value moves with trader
            outcomes and the fees earned by the pool.
          </p>
        </section>

        <section className="liquidity-portfolio" aria-labelledby="liquidity-portfolio-title">
          <div className="liquidity-section-heading">
            <div>
              <h2 id="liquidity-portfolio-title">Your liquidity</h2>
              <p>Contract ownership with indexed deposit history.</p>
            </div>
            <span className={`sync-state ${
              refreshing || indexer.status !== "ready" ? "is-syncing" : ""
            }`}>
              {syncLabel}
            </span>
          </div>
          <div className="liquidity-metrics">
            <div>
              <span>Shares</span>
              <strong className="num">
                {connected ? formatShares(values.userShares) : "—"}
              </strong>
              <small>On-chain LP shares</small>
            </div>
            <div>
              <span>Current value</span>
              <strong className="num">
                {connected ? `$${formatUsdcMinor(values.currentValue)}` : "—"}
              </strong>
              <small>Redeemable USDC estimate</small>
            </div>
            <div>
              <span>Deposited</span>
              <strong className="num">{depositedLabel}</strong>
              <small>{depositedNote}</small>
            </div>
          </div>
          {connected &&
          (indexer.status === "disabled" ||
            indexer.status === "unavailable") ? (
            <div className="liquidity-indexer-warning" role="status">
              <span>
                Deposit history is temporarily unavailable. Liquidity actions
                still use live contract state.
              </span>
              {indexer.status === "unavailable" ? (
                <button type="button" onClick={indexer.refresh}>Retry</button>
              ) : null}
            </div>
          ) : null}
        </section>

        <div className="liquidity-columns">
          <section className="liquidity-action-card" aria-labelledby="liquidity-action-title">
            <div className="liquidity-tabs" role="tablist" aria-label="Liquidity action">
              {(["add", "remove"] as const).map((value) => (
                <button
                  key={value}
                  className={action === value ? "is-active" : ""}
                  onClick={() => chooseAction(value)}
                  role="tab"
                  aria-selected={action === value}
                  type="button"
                >
                  {value === "add" ? "Add" : "Remove"}
                </button>
              ))}
            </div>

            <div className="liquidity-action-copy">
              <h2 id="liquidity-action-title">
                {action === "add" ? "Add liquidity" : "Remove liquidity"}
              </h2>
              <p>
                {action === "add"
                  ? "Deposit USDC and receive shares at the pool’s current value."
                  : "Redeem shares for their current USDC value in one transaction."}
              </p>
            </div>

            <label className="liquidity-amount-label" htmlFor="liquidity-amount">
              {action === "add" ? "USDC amount" : "USDC to receive"}
            </label>
            <div className="liquidity-amount">
              <span>$</span>
              <input
                id="liquidity-amount"
                className="num"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setRemoveSharesOverride(null);
                }}
              />
              <b>USDC</b>
            </div>

            {action === "add" ? (
              <div className="liquidity-presets" aria-label="Add amount presets">
                {[25, 100, 500].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setAmount(String(preset))}
                    type="button"
                  >
                    ${preset}
                  </button>
                ))}
              </div>
            ) : (
              <div className="liquidity-presets" aria-label="Remove amount presets">
                {[25n, 50n, 100n].map((percentage) => (
                  <button
                    key={percentage.toString()}
                    disabled={values.maxRemovableShares <= 0n}
                    onClick={() => chooseRemoval(percentage)}
                    type="button"
                  >
                    {percentage === 100n ? "Max" : `${percentage}%`}
                  </button>
                ))}
              </div>
            )}

            <div className="liquidity-quote">
              <span>
                {action === "add" ? "Estimated shares" : "Shares redeemed"}
              </span>
              <strong className="num">
                {formatShares(
                  action === "add"
                    ? values.estimatedAddShares
                    : values.requestedRemoveShares,
                )}
              </strong>
              {action === "remove" ? (
                <>
                  <span>Expected USDC</span>
                  <strong className="num">
                    ${formatUsdcMinor(values.expectedRemoveAssets)}
                  </strong>
                </>
              ) : null}
            </div>

            {snapshot.userLiquidityStatus !== "ready" && connected ? (
              <p className="liquidity-setup-note">
                First deposit requires one additional wallet signature to create
                and route your liquidity account.
              </p>
            ) : null}
            {marketHasRisk ? (
              <p className="liquidity-blocked-note">
                Liquidity changes resume when all open positions settle.
              </p>
            ) : null}
            {action === "add" && values.marketMode === "close-only" ? (
              <p className="liquidity-blocked-note">
                Deposits are paused while this market is close-only.
              </p>
            ) : null}
            {action === "remove" &&
            values.inputMinor &&
            values.requestedRemoveShares > values.maxRemovableShares ? (
              <p className="liquidity-blocked-note">
                This market must retain its minimum open liquidity.
              </p>
            ) : null}
            {!connected ? (
              <p className="liquidity-blocked-note">
                Connect a wallet to manage liquidity.
              </p>
            ) : null}

            {pending ? (
              <div className="pending-withdrawal">
                <div>
                  <strong>Withdrawal pending</strong>
                  <span className="num">
                    {formatShares(values.pendingShares)} shares are ready to complete.
                  </span>
                </div>
                <button
                  disabled={transaction.busy || marketHasRisk}
                  onClick={transaction.completePending}
                  type="button"
                >
                  Complete removal
                </button>
              </div>
            ) : null}

            <button
              className="liquidity-submit"
              disabled={actionDisabled}
              onClick={submit}
              type="button"
            >
              {transaction.busy
                ? "Confirming…"
                : action === "add"
                  ? "Add liquidity"
                  : "Remove liquidity"}
            </button>
            <p className="liquidity-guard">
              Estimated quote · protected by a 0.5% minimum-output guard.
            </p>
            {transaction.statusMessage ? (
              <p
                className={`liquidity-status ${transaction.statusTone}`}
                role={transaction.statusTone === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {transaction.statusMessage}
              </p>
            ) : null}
          </section>

          <section className="market-liquidity-card" aria-labelledby="market-liquidity-title">
            <div className="liquidity-section-heading">
              <div>
                <h2 id="market-liquidity-title">Market details</h2>
                <p>Indexed market state with live contract fallback.</p>
              </div>
            </div>
            <dl>
              <div>
                <dt>Pool liquidity</dt>
                <dd className="num">${formatUsdcMinor(values.poolBalance)} USDC</dd>
              </div>
              <div>
                <dt>Your pool share</dt>
                <dd className="num">
                  {connected
                    ? ownershipPercent(values.userShares, values.totalShares)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Total LP shares</dt>
                <dd className="num">{formatShares(values.totalShares)}</dd>
              </div>
              <div>
                <dt>Market status</dt>
                <dd className={`market-state ${
                  marketStatus === "Available" ? "available" : "waiting"
                }`}>
                  <i aria-hidden="true" />
                  {marketStatus}
                </dd>
              </div>
            </dl>
            <p className="market-liquidity-note">
              Liquidity can only change when there are no active positions, so
              the pool cannot be reduced underneath an open play.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
