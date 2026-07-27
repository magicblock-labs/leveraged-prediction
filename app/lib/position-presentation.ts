import { playStatusAt, type Play, type PlayStatus } from "@/app/lib/domain";

const FINAL_SECONDS = 3;

export interface PositionWatchState {
  status: PlayStatus;
  progress: number;
  remainingSeconds: number;
  result: "ahead" | "chasing" | "level";
  isFinalSeconds: boolean;
  finishLabel: string;
}

export function positionWatchState(
  play: Play,
  now: number,
): PositionWatchState {
  const status = playStatusAt(play, now);
  const duration = Math.max(1, play.expiresAt - play.openedAt);
  const progress = Math.max(
    0,
    Math.min(1, (now - play.openedAt) / duration),
  );
  const remainingSeconds = Math.max(0, (play.expiresAt - now) / 1_000);
  const move = play.priceMovePercent ?? 0;

  return {
    status,
    progress,
    remainingSeconds,
    result: move > 0 ? "ahead" : move < 0 ? "chasing" : "level",
    isFinalSeconds: status === "active" && remainingSeconds <= FINAL_SECONDS,
    finishLabel: `Finish ${play.direction === "up" ? "above" : "below"} $${play.entryPrice.toLocaleString(
      undefined,
      { maximumFractionDigits: 2 },
    )}`,
  };
}

export function winProfitUsd(play: Play): number | null {
  if (play.status !== "won") return null;
  const profit = positionProfitUsd(play);
  return profit === null ? null : Math.max(0, profit);
}

export function positionProfitUsd(play: Play): number | null {
  if (play.payoutUsd === undefined) return null;
  return play.payoutUsd - play.collateralUsd;
}
