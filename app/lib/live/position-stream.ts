import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  estimateProfit,
  priceMovePercent,
  type MarketSnapshot,
  type Play,
} from "@/app/lib/domain";
import {
  decodeMarket,
  decodeUserPositions,
  type DecodedCompactPosition,
} from "@/app/lib/live/decode";
import { ORACLE_EXPONENT } from "@/app/lib/live/oracle";
import { marketPda, userPositionsPda } from "@/app/lib/live/pdas";

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

export interface MarketStreamUpdate {
  activePositions: number;
  nextPositionNonce: number;
  marketMode: "open" | "close-only";
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
  const collateralUsd = position.collateral / 1_000_000;
  return {
    id: `${position.marketId}-${position.nonce}`,
    marketId: position.marketId,
    direction: position.direction,
    collateralUsd,
    entryPrice,
    openedAt: expiresAt - 10_000,
    expiresAt,
    refundAt,
    status: now < expiresAt ? "active" : now < refundAt ? "settling" : "refunding",
    priceMovePercent: priceMovePercent(
      entryPrice,
      currentPrice,
      position.direction,
    ),
    liveProfitUsd: estimateProfit(
      collateralUsd,
      entryPrice,
      currentPrice,
      position.direction,
    ),
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

export function applyMarketStreamUpdate(
  snapshot: MarketSnapshot,
  update: MarketStreamUpdate,
): MarketSnapshot {
  return {
    ...snapshot,
    activePositions: update.activePositions,
    nextPositionNonce: update.nextPositionNonce,
    marketMode: update.marketMode,
    notice: "Live mode · oracle, Market, and position websockets connected",
  };
}

export function subscribeMarketState(
  config: Omit<PositionStreamConfig, "userAddress">,
  onMarket: (update: MarketStreamUpdate) => void,
  onError: (error: unknown) => void,
  suppliedConnection?: PositionStreamConnection,
): () => void {
  let connection: PositionStreamConnection;
  let programId: PublicKey;
  try {
    connection = suppliedConnection ?? new Connection(config.erEndpoint, {
      commitment: COMMITMENT,
    });
    programId = new PublicKey(config.programId);
  } catch (error) {
    onError(error);
    return () => undefined;
  }
  const address = marketPda(programId, config.marketId);
  let subscriptionId: number | null = null;
  let disposed = false;
  let receivedWebsocketUpdate = false;

  const receive = (account: AccountInfo<Buffer>, fromWebsocket = true) => {
    try {
      if (!account.owner.equals(programId)) {
        throw new Error("Market websocket account has the wrong owner");
      }
      if (fromWebsocket) receivedWebsocketUpdate = true;
      const market = decodeMarket(Buffer.from(account.data));
      if (market.marketId !== config.marketId) {
        throw new Error("Market websocket account has the wrong ID");
      }
      onMarket({
        activePositions: market.activePositions,
        nextPositionNonce: market.nextPositionNonce,
        marketMode: market.mode,
        receivedAt: Date.now(),
      });
    } catch (error) {
      onError(error);
    }
  };

  void connection.getAccountInfo(address, COMMITMENT)
    .then((account) => {
      if (disposed || receivedWebsocketUpdate) return;
      if (!account) throw new Error("Market websocket account was not found");
      receive(account, false);
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
  const streamLabel = "[positions:websocket]";
  let subscriptionId: number | null = null;
  let disposed = false;
  let receivedWebsocketUpdate = false;

  const receive = (account: AccountInfo<Buffer>, fromWebsocket = true) => {
    try {
      if (!account.owner.equals(programId)) {
        throw new Error("UserPositions websocket account has the wrong owner");
      }
      if (fromWebsocket) {
        receivedWebsocketUpdate = true;
        console.info(streamLabel, "account update received", {
          address: address.toBase58(),
          dataBytes: account.data.length,
        });
      }
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
      console.info(streamLabel, "subscribed", {
        address: address.toBase58(),
        endpoint: config.erEndpoint,
        subscriptionId: id,
      });
    }
  } catch (error) {
    onError(error);
  }

  return () => {
    disposed = true;
    if (subscriptionId !== null) {
      console.info(streamLabel, "unsubscribing", {
        address: address.toBase58(),
        subscriptionId,
      });
      void connection.removeAccountChangeListener(subscriptionId).catch(onError);
    }
  };
}
