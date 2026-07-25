import { describe, expect, it } from "vitest";
import type { Play } from "@/app/lib/domain";
import type { IndexedPosition } from "@/app/lib/indexer/client";
import {
  mergeIndexedPosition,
  mergePersistentPositions,
} from "@/app/lib/indexer/positions";

const direct: Play = {
  id: "1-9",
  marketId: 1,
  direction: "up",
  collateralUsd: 10,
  entryPrice: 100,
  openedAt: 1_000,
  expiresAt: 11_000,
  refundAt: 21_000,
  status: "active",
};

function indexed(
  overrides: Partial<IndexedPosition> = {},
): IndexedPosition {
  return {
    market_id: 1,
    position_id: 9,
    user: "wallet",
    direction: "up",
    entry_price: "10000000000",
    collateral: "10000000",
    expires_at: "1970-01-01T00:00:11.000Z",
    lifecycle_status: "open",
    checkpoint_status: "er_only",
    outcome: null,
    payout_amount: null,
    net_pnl: null,
    opened_at: "1970-01-01T00:00:01.000Z",
    closed_at: null,
    ...overrides,
  };
}

describe("persistent position merge", () => {
  it("retains an account-observed position when a later account snapshot omits it", () => {
    const retained = new Map([[direct.id, direct]]);

    const positions = mergePersistentPositions(
      retained.values(),
      [],
      101,
      2_000,
    );

    expect(positions.map((position) => position.id)).toEqual(["1-9"]);
  });

  it("enriches the same position with canonical settlement data", () => {
    const positions = mergePersistentPositions(
      [direct],
      [indexed({
        lifecycle_status: "settled",
        outcome: "won",
        payout_amount: "55000000",
        net_pnl: "45000000",
        closed_at: "1970-01-01T00:00:11.500Z",
      })],
      101,
      12_000,
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      id: "1-9",
      status: "won",
      payoutUsd: 55,
      entryPrice: 100,
    });
  });

  it("does not regress a terminal websocket update to a stale HTTP open row", () => {
    const won = indexed({ lifecycle_status: "settled", outcome: "won" });
    expect(mergeIndexedPosition(won, indexed())).toBe(won);
  });

  it("maps losses and breakevens to distinct terminal states", () => {
    const positions = mergePersistentPositions(
      [],
      [
        indexed({ position_id: 10, lifecycle_status: "settled", outcome: "lost" }),
        indexed({ position_id: 11, lifecycle_status: "settled", outcome: "breakeven" }),
      ],
      99,
      12_000,
    );
    expect(positions.map((position) => position.status).sort()).toEqual([
      "breakeven",
      "lost",
    ]);
  });
});
