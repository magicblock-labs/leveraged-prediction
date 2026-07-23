import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  updatePlayPriceMove,
  type FeedHealth,
  type MarketSnapshot,
  type PricePoint,
} from "@/app/lib/domain";
import { ORACLE_PROGRAM_ID } from "@/app/lib/live/config";
import {
  decodeOraclePrice,
  ORACLE_MAX_AGE_SECONDS,
  type OraclePrice,
} from "@/app/lib/live/oracle";

const COMMITMENT: Commitment = "confirmed";
const HISTORY_WINDOW_MS = 45_000;
const HISTORY_SAMPLE_MS = 100;
const MAX_HISTORY_POINTS = Math.ceil(HISTORY_WINDOW_MS / HISTORY_SAMPLE_MS) + 2;

export interface OracleStreamUpdate extends OraclePrice {
  receivedAt: number;
}

export interface OracleStreamConnection {
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

export interface OracleStreamConfig {
  erEndpoint: string;
  oracleAddress: string;
  oracleFeedId: string;
}

export function feedIdFromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Oracle feed ID must be 32-byte hex");
  }
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function appendOraclePrice(
  history: PricePoint[],
  update: Pick<OracleStreamUpdate, "displayPrice" | "receivedAt">,
): PricePoint[] {
  const nextPoint = { price: update.displayPrice, timestamp: update.receivedAt };
  return mergeOraclePriceHistory(history, [nextPoint], update.receivedAt);
}

export function mergeOraclePriceHistory(
  current: PricePoint[],
  incoming: PricePoint[],
  now: number,
): PricePoint[] {
  const cutoff = now - HISTORY_WINDOW_MS;
  const sorted = [...current, ...incoming]
    .filter((point) =>
      Number.isFinite(point.price) &&
      Number.isFinite(point.timestamp) &&
      point.timestamp >= cutoff
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  const sampled: PricePoint[] = [];
  for (const point of sorted) {
    const previous = sampled.at(-1);
    if (
      previous &&
      Math.floor(previous.timestamp / HISTORY_SAMPLE_MS) ===
        Math.floor(point.timestamp / HISTORY_SAMPLE_MS)
    ) {
      sampled[sampled.length - 1] = point;
    } else {
      sampled.push(point);
    }
  }
  return sampled.slice(-MAX_HISTORY_POINTS);
}

export function feedHealthAt(publishTime: number, now: number): {
  ageSeconds: number;
  health: FeedHealth;
} {
  const ageSeconds = Math.max(0, now / 1_000 - publishTime);
  let health: FeedHealth = "offline";
  if (ageSeconds <= ORACLE_MAX_AGE_SECONDS) health = "live";
  else if (ageSeconds <= 10) health = "delayed";
  return { ageSeconds, health };
}

export function applyOracleStreamUpdate(
  snapshot: MarketSnapshot,
  update: OracleStreamUpdate,
): MarketSnapshot {
  const feed = feedHealthAt(update.publishTime, update.receivedAt);
  return {
    ...snapshot,
    currentPrice: update.displayPrice,
    currentRawPrice: update.rawPrice.toString(),
    priceHistory: appendOraclePrice(snapshot.priceHistory, update),
    plays: snapshot.plays.map((play) => updatePlayPriceMove(play, update.displayPrice)),
    feedAgeSeconds: feed.ageSeconds,
    feedHealth: feed.health,
    capturedAt: update.receivedAt,
    notice: "Live mode · oracle websocket connected",
  };
}

export function subscribeOraclePrice(
  config: OracleStreamConfig,
  onPrice: (update: OracleStreamUpdate) => void,
  onError: (error: unknown) => void,
  suppliedConnection?: OracleStreamConnection,
): () => void {
  let connection: OracleStreamConnection;
  let oracleAddress: PublicKey;
  let expectedFeedId: Uint8Array;
  try {
    connection = suppliedConnection ?? new Connection(config.erEndpoint, {
      commitment: COMMITMENT,
    });
    oracleAddress = new PublicKey(config.oracleAddress);
    expectedFeedId = feedIdFromHex(config.oracleFeedId);
  } catch (error) {
    onError(error);
    return () => undefined;
  }
  let subscriptionId: number | null = null;
  let disposed = false;
  let latestPostedSlot = 0n;

  const receive = (account: AccountInfo<Buffer>) => {
    try {
      if (!account.owner.equals(ORACLE_PROGRAM_ID)) {
        throw new Error("Oracle websocket account has the wrong owner");
      }
      const receivedAt = Date.now();
      const price = decodeOraclePrice(
        Buffer.from(account.data),
        expectedFeedId,
        Math.floor(receivedAt / 1_000),
      );
      if (price.postedSlot <= latestPostedSlot) return;
      latestPostedSlot = price.postedSlot;
      onPrice({ ...price, receivedAt });
    } catch (error) {
      onError(error);
    }
  };

  void connection.getAccountInfo(oracleAddress, COMMITMENT)
    .then((account) => {
      if (disposed) return;
      if (!account) throw new Error("Oracle websocket account was not found on the routed ER");
      receive(account);
    })
    .catch(onError);

  try {
    const id = connection.onAccountChange(oracleAddress, receive, COMMITMENT);
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
