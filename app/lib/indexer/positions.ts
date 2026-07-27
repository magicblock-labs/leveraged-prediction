import {
  playStatusAt,
  updatePlayPriceMove,
  type Play,
  type PlayStatus,
} from "@/app/lib/domain";
import type { IndexedPosition } from "@/app/lib/indexer/client";

const USDC_SCALE = 1_000_000;
const PRICE_SCALE = 100_000_000;
const ROUND_DURATION_MS = 10_000;
const REFUND_GRACE_MS = 10_000;

export function positionIdentity(marketId: number, positionId: number): string {
  return `${marketId}-${positionId}`;
}

export function indexedPositionStatus(position: IndexedPosition): PlayStatus {
  if (position.lifecycle_status === "open") return "active";
  if (position.lifecycle_status === "refunded" || position.outcome === "refunded") {
    return "refunded";
  }
  if (position.outcome === "won") return "won";
  if (position.outcome === "lost") return "lost";
  return "breakeven";
}

export function mergeIndexedPosition(
  current: IndexedPosition | undefined,
  incoming: IndexedPosition,
): IndexedPosition {
  if (
    current &&
    current.lifecycle_status !== "open" &&
    incoming.lifecycle_status === "open"
  ) {
    return current;
  }
  return incoming;
}

function finiteNumber(value: string | null, scale: number): number | undefined {
  if (value === null) return undefined;
  const number = Number(value) / scale;
  return Number.isFinite(number) ? number : undefined;
}

function timestamp(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function indexedPositionToPlay(
  position: IndexedPosition,
  fallback: Play | undefined,
  currentPrice: number,
  now: number,
): Play | null {
  const id = positionIdentity(position.market_id, position.position_id);
  const expiresAt = timestamp(position.expires_at) ?? fallback?.expiresAt;
  const openedAt =
    timestamp(position.opened_at) ??
    fallback?.openedAt ??
    (expiresAt === undefined ? undefined : expiresAt - ROUND_DURATION_MS);
  const direction = position.direction ?? fallback?.direction;
  const entryPrice =
    finiteNumber(position.entry_price, PRICE_SCALE) ?? fallback?.entryPrice;
  const collateralUsd =
    finiteNumber(position.collateral, USDC_SCALE) ?? fallback?.collateralUsd;
  if (
    expiresAt === undefined ||
    openedAt === undefined ||
    direction === undefined ||
    entryPrice === undefined ||
    collateralUsd === undefined
  ) {
    return fallback ?? null;
  }

  const terminalStatus = indexedPositionStatus(position);
  const status =
    terminalStatus === "active"
      ? now < expiresAt
        ? "active"
        : now < expiresAt + REFUND_GRACE_MS
          ? "settling"
          : "refunding"
      : terminalStatus;
  const play: Play = {
    ...fallback,
    id,
    marketId: position.market_id,
    direction,
    entryPrice,
    collateralUsd,
    openedAt,
    expiresAt,
    refundAt: expiresAt + REFUND_GRACE_MS,
    status,
    payoutUsd:
      finiteNumber(position.payout_amount, USDC_SCALE) ?? fallback?.payoutUsd,
  };
  return updatePlayPriceMove(play, currentPrice);
}

export function mergePersistentPositions(
  directPositions: Iterable<Play>,
  indexedPositions: Iterable<IndexedPosition>,
  currentPrice: number,
  now: number,
): Play[] {
  const merged = new Map<string, Play>();
  for (const play of directPositions) {
    const current = { ...play, status: playStatusAt(play, now) };
    merged.set(play.id, updatePlayPriceMove(current, currentPrice));
  }
  for (const position of indexedPositions) {
    const id = positionIdentity(position.market_id, position.position_id);
    const play = indexedPositionToPlay(
      position,
      merged.get(id),
      currentPrice,
      now,
    );
    if (play) merged.set(id, play);
  }
  return [...merged.values()].sort(
    (left, right) =>
      right.openedAt - left.openedAt || right.id.localeCompare(left.id),
  );
}
