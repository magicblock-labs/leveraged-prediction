export type Direction = "up" | "down";

export type PlayStatus =
  | "submitting"
  | "active"
  | "settling"
  | "refunding"
  | "won"
  | "lost"
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
  estimateUsd?: number;
  payoutUsd?: number;
  claimableUsd?: number;
}

export interface MarketSnapshot {
  mode: "live";
  marketId: number;
  marketLabel: string;
  gameLabel: string;
  currentPrice: number;
  priceExponent: number;
  priceHistory: PricePoint[];
  feedHealth: FeedHealth;
  feedAgeSeconds: number;
  marketMode: "open" | "close-only";
  activePositions: number;
  maxPositions: number;
  walletAddress: string | null;
  walletBalanceUsd: number | null;
  fallbackClaimableUsd: number;
  plays: Play[];
  capturedAt: number;
  erEndpoint?: string;
  oracleAddress?: string;
  oracleFeedId?: string;
  notice?: string;
}

export interface SnapshotError {
  error: string;
  code: "LIVE_NOT_CONFIGURED" | "LIVE_UNAVAILABLE" | "INVALID_REQUEST";
}

export function playStatusAt(play: Play, now: number): PlayStatus {
  if (["won", "lost", "refunded", "submitting"].includes(play.status)) {
    return play.status;
  }
  if (now < play.expiresAt) return "active";
  if (now < play.refundAt) return "settling";
  return "refunding";
}

export function maximumProfit(collateralUsd: number): number {
  return collateralUsd * 0.9;
}
