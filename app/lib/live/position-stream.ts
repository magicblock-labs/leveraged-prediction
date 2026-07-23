import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import type { MarketSnapshot, Play } from "@/app/lib/domain";
import {
  decodeUserPositions,
  type DecodedCompactPosition,
} from "@/app/lib/live/decode";
import { ORACLE_EXPONENT } from "@/app/lib/live/oracle";
import { userPositionsPda } from "@/app/lib/live/pdas";

const COMMITMENT: Commitment = "confirmed";
const PRICE_SCALE = 10 ** ORACLE_EXPONENT;

export interface PositionStreamConnection {
  getAccountInfo(
    address: PublicKey,
    commitment: Commitment,
  ): Promise<AccountInfo<Buffer> | null>;
  onAccountChange(
    address: PublicKey,
    callback: (account: AccountInfo<Buffer>) => void,
    commitment: Commitment,
  ): number;
  removeAccountChangeListener(subscriptionId: number): Promise<void>;
}

export interface PositionStreamConfig {
  erEndpoint: string;
  programId: string;
  userAddress: string;
  marketId: number;
}

export interface PositionStreamUpdate {
  positions: DecodedCompactPosition[];
  receivedAt: number;
}

export function positionToPlay(
  position: DecodedCompactPosition,
  now: number,
  currentPrice: number,
): Play {
  const expiresAt = position.expiresAt * 1_000;
  const refundAt = expiresAt + 10_000;
  const entryPrice = Number(position.entryPrice) / PRICE_SCALE;
  const isFavorable =
    position.direction === "up" ? currentPrice > entryPrice : currentPrice < entryPrice;
  return {
    id: `${position.marketId}-${position.nonce}`,
    marketId: position.marketId,
    direction: position.direction,
    collateralUsd: position.collateral / 1_000_000,
    entryPrice,
    openedAt: expiresAt - 10_000,
    expiresAt,
    refundAt,
    status: now < expiresAt ? "active" : now < refundAt ? "settling" : "refunding",
    estimateUsd: isFavorable
      ? (position.collateral / 1_000_000) * 0.9
      : -(position.collateral / 1_000_000),
  };
}

export function applyPositionStreamUpdate(
  snapshot: MarketSnapshot,
  update: PositionStreamUpdate,
): MarketSnapshot {
  return {
    ...snapshot,
    plays: update.positions
      .filter((position) => position.marketId === snapshot.marketId)
      .map((position) => positionToPlay(position, update.receivedAt, snapshot.currentPrice)),
    notice: "Live mode · oracle and position websockets connected",
  };
}

export function subscribeUserPositions(
  config: PositionStreamConfig,
  onPositions: (update: PositionStreamUpdate) => void,
  onError: (error: unknown) => void,
  suppliedConnection?: PositionStreamConnection,
): () => void {
  let connection: PositionStreamConnection;
  let programId: PublicKey;
  let user: PublicKey;
  try {
    connection = suppliedConnection ?? new Connection(config.erEndpoint, {
      commitment: COMMITMENT,
    });
    programId = new PublicKey(config.programId);
    user = new PublicKey(config.userAddress);
  } catch (error) {
    onError(error);
    return () => undefined;
  }
  const address = userPositionsPda(programId, user);
  let subscriptionId: number | null = null;
  let disposed = false;
  let receivedWebsocketUpdate = false;

  const receive = (account: AccountInfo<Buffer>, fromWebsocket = true) => {
    try {
      if (!account.owner.equals(programId)) {
        throw new Error("UserPositions websocket account has the wrong owner");
      }
      if (fromWebsocket) receivedWebsocketUpdate = true;
      onPositions({
        positions: decodeUserPositions(Buffer.from(account.data)),
        receivedAt: Date.now(),
      });
    } catch (error) {
      onError(error);
    }
  };

  void connection.getAccountInfo(address, COMMITMENT)
    .then((account) => {
      if (disposed) return;
      if (receivedWebsocketUpdate) return;
      if (account) receive(account, false);
      else onPositions({ positions: [], receivedAt: Date.now() });
    })
    .catch(onError);

  try {
    const id = connection.onAccountChange(address, receive, COMMITMENT);
    if (disposed) {
      void connection.removeAccountChangeListener(id).catch(onError);
    } else {
      subscriptionId = id;
    }
  } catch (error) {
    onError(error);
  }

  return () => {
    disposed = true;
    if (subscriptionId !== null) {
      void connection.removeAccountChangeListener(subscriptionId).catch(onError);
    }
  };
}
