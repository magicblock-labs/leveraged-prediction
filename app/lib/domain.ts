export type Direction = "up" | "down";

export type PlayStatus =
  | "submitting"
  | "active"
  | "settling"
  | "refunding"
  | "won"
  | "lost"
  | "breakeven"
  | "refunded";

export type FeedHealth = "live" | "delayed" | "offline";

export interface PricePoint {
  price: number;
  timestamp: number;
}

export interface Play {
  id: string;
  marketId: number;
  direction: Direction;
  collateralUsd: number;
  entryPrice: number;
  openedAt: number;
  expiresAt: number;
  refundAt: number;
  status: PlayStatus;
  priceMovePercent?: number;
  liveProfitUsd?: number;
  payoutUsd?: number;
  claimableUsd?: number;
}

export interface MarketSnapshot {
  mode: "live";
  marketId: number;
  marketLabel: string;
  gameLabel: string;
  currentPrice: number;
  currentRawPrice?: string;
  priceExponent: number;
  priceHistory: PricePoint[];
  feedHealth: FeedHealth;
  feedAgeSeconds: number;
  marketMode: "open" | "close-only";
  activePositions: number;
  nextPositionNonce?: number;
  maxPositions: number;
  walletAddress: string | null;
  walletBalanceUsd: number | null;
  fallbackClaimableUsd: number;
  plays: Play[];
  capturedAt: number;
  erEndpoint?: string;
  collateralMint?: string;
  oracleAddress?: string;
  oracleFeedId?: string;
  notice?: string;
}

export interface SnapshotError {
  error: string;
  code: "LIVE_NOT_CONFIGURED" | "LIVE_UNAVAILABLE" | "INVALID_REQUEST";
}

export const LEVERAGE_MULTIPLIER = 1_000;
export const MAX_GROSS_PROFIT_MULTIPLIER = 5;
export const PROFIT_FEE_RATE = 0.1;

export function playStatusAt(play: Play, now: number): PlayStatus {
  if (["won", "lost", "breakeven", "refunded", "submitting"].includes(play.status)) {
    return play.status;
  }
  if (now < play.expiresAt) return "active";
  if (now < play.refundAt) return "settling";
  return "refunding";
}

export function maximumProfit(collateralUsd: number): number {
  return collateralUsd * MAX_GROSS_PROFIT_MULTIPLIER * (1 - PROFIT_FEE_RATE);
}

export function estimateProfit(
  collateralUsd: number,
  entryPrice: number,
  currentPrice: number,
  direction: Direction,
): number {
  if (
    collateralUsd <= 0 ||
    entryPrice <= 0 ||
    currentPrice <= 0 ||
    !Number.isFinite(collateralUsd) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return 0;
  }

  const priceMove = (currentPrice - entryPrice) / entryPrice;
  const directedMove = direction === "up" ? priceMove : -priceMove;
  const grossProfit = collateralUsd * LEVERAGE_MULTIPLIER * directedMove;

  if (grossProfit >= 0) {
    return Math.min(
      grossProfit,
      collateralUsd * MAX_GROSS_PROFIT_MULTIPLIER,
    ) * (1 - PROFIT_FEE_RATE);
  }

  return Math.max(grossProfit, -collateralUsd);
}

export function priceMovePercent(
  entryPrice: number,
  currentPrice: number,
  direction: Direction,
): number {
  if (
    entryPrice <= 0 ||
    currentPrice <= 0 ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return 0;
  }
  const move = ((currentPrice - entryPrice) / entryPrice) * 100;
  return direction === "up" ? move : -move;
}

export function updatePlayPriceMove(play: Play, currentPrice: number): Play {
  if (!["active", "settling", "refunding"].includes(play.status)) return play;
  return {
    ...play,
    priceMovePercent: priceMovePercent(
      play.entryPrice,
      currentPrice,
      play.direction,
    ),
    liveProfitUsd: estimateProfit(
      play.collateralUsd,
      play.entryPrice,
      currentPrice,
      play.direction,
    ),
  };
}
