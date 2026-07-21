import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import type { MarketSnapshot, Play, PricePoint } from "@/app/lib/domain";
import {
  decodeMarket,
  decodeProtocolConfig,
  decodeUserPositions,
  accountDiscriminator,
} from "@/app/lib/live/decode";
import { ORACLE_PROGRAM_ID, readLiveConfig } from "@/app/lib/live/config";
import {
  marketPda,
  protocolConfigPda,
  userPositionsPda,
} from "@/app/lib/live/pdas";
import {
  getDelegationStatus,
  normalizeErEndpoint,
} from "@/app/lib/live/router";
import { Buffer } from "buffer";

const ORACLE_EXPONENT = 8;
const ORACLE_MAX_AGE_SECONDS = 2;
const ORACLE_MAX_CONFIDENCE_BPS = 1;
const PRICE_SCALE = 10 ** ORACLE_EXPONENT;
const historyByOracle = new Map<string, PricePoint[]>();

interface PriceUpdateAccount {
  verificationLevel: Record<string, unknown>;
  priceMessage: {
    feedId: number[];
    price: { toString(): string };
    conf: { toString(): string };
    exponent: number;
    publishTime: { toString(): string };
  };
  postedSlot: { toString(): string };
}

const priceUpdateIdl = {
  address: ORACLE_PROGRAM_ID.toBase58(),
  metadata: {
    name: "magicblock_pricing_oracle_view",
    version: "0.1.0",
    spec: "0.1.0",
  },
  instructions: [],
  accounts: [
    {
      name: "PriceUpdateV2",
      discriminator: [...accountDiscriminator("PriceUpdateV2")],
    },
  ],
  types: [
    {
      name: "PriceUpdateV2",
      type: {
        kind: "struct",
        fields: [
          { name: "writeAuthority", type: "pubkey" },
          { name: "verificationLevel", type: { defined: { name: "VerificationLevel" } } },
          { name: "priceMessage", type: { defined: { name: "PriceFeedMessage" } } },
          { name: "postedSlot", type: "u64" },
        ],
      },
    },
    {
      name: "VerificationLevel",
      type: {
        kind: "enum",
        variants: [
          { name: "Partial", fields: [{ name: "numSignatures", type: "u8" }] },
          { name: "Full" },
        ],
      },
    },
    {
      name: "PriceFeedMessage",
      type: {
        kind: "struct",
        fields: [
          { name: "feedId", type: { array: ["u8", 32] } },
          { name: "price", type: "i64" },
          { name: "conf", type: "u64" },
          { name: "exponent", type: "i32" },
          { name: "publishTime", type: "i64" },
          { name: "prevPublishTime", type: "i64" },
          { name: "emaPrice", type: "i64" },
          { name: "emaConf", type: "u64" },
        ],
      },
    },
  ],
} as Idl;

const priceCoder = new BorshAccountsCoder(priceUpdateIdl);

function asBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decodeOraclePrice(
  data: Buffer,
  expectedFeedId: Uint8Array,
  nowSeconds: number,
): { displayPrice: number; rawPrice: bigint; ageSeconds: number } {
  const update = priceCoder.decode("PriceUpdateV2", data) as PriceUpdateAccount;
  const message = update.priceMessage;
  const rawPrice = BigInt(message.price.toString());
  const confidence = BigInt(message.conf.toString());
  const publishTime = Number(message.publishTime.toString());
  const postedSlot = BigInt(update.postedSlot.toString());
  const ageSeconds = nowSeconds - publishTime;

  if (!bytesEqual(asBytes(message.feedId), expectedFeedId)) {
    throw new Error("Oracle feed ID does not match the configured Market");
  }
  if (message.exponent !== ORACLE_EXPONENT) {
    throw new Error(`Oracle exponent ${message.exponent} does not match ${ORACLE_EXPONENT}`);
  }
  const fullyVerified =
    "full" in update.verificationLevel || "Full" in update.verificationLevel;
  if (!fullyVerified || postedSlot === 0n) {
    throw new Error("Oracle update is not fully verified and posted");
  }
  if (rawPrice <= 0n || ageSeconds < 0 || ageSeconds > ORACLE_MAX_AGE_SECONDS) {
    throw new Error(`Oracle update is stale or invalid (${ageSeconds.toFixed(1)}s old)`);
  }
  if (confidence * 10_000n > rawPrice * BigInt(ORACLE_MAX_CONFIDENCE_BPS)) {
    throw new Error("Oracle confidence interval exceeds the market limit");
  }

  return { displayPrice: Number(rawPrice) / PRICE_SCALE, rawPrice, ageSeconds };
}

function updateHistory(oracle: string, price: number, now: number): PricePoint[] {
  const current = historyByOracle.get(oracle) ?? [];
  const next = [...current, { price, timestamp: now }]
    .filter((point) => point.timestamp >= now - 45_000)
    .slice(-120);
  historyByOracle.set(oracle, next);
  if (next.length > 1) return next;
  return Array.from({ length: 46 }, (_, index) => ({
    price,
    timestamp: now - (45 - index) * 1_000,
  }));
}

function toPlay(
  position: ReturnType<typeof decodeUserPositions>[number],
  now: number,
  currentPrice: number,
): Play {
  const expiresAt = position.expiresAt * 1_000;
  const refundAt = expiresAt + 10_000;
  const entryPrice = Number(position.entryPrice) / PRICE_SCALE;
  const isFavorable =
    position.direction === "up" ? currentPrice > entryPrice : currentPrice < entryPrice;
  const status = now < expiresAt ? "active" : now < refundAt ? "settling" : "refunding";
  return {
    id: `${position.marketId}-${position.nonce}`,
    marketId: position.marketId,
    direction: position.direction,
    collateralUsd: position.collateral / 1_000_000,
    entryPrice,
    openedAt: expiresAt - 10_000,
    expiresAt,
    refundAt,
    status,
    estimateUsd: isFavorable ? (position.collateral / 1_000_000) * 0.9 : -(position.collateral / 1_000_000),
  };
}

export async function readLiveSnapshot(walletAddress?: string): Promise<MarketSnapshot> {
  const config = readLiveConfig();
  const now = Date.now();
  const baseConnection = new Connection(config.baseRpcEndpoint, "confirmed");
  const marketAddress = marketPda(config.programId, config.marketId);
  const baseMarketInfo = await baseConnection.getAccountInfo(marketAddress, "confirmed");
  if (!baseMarketInfo) throw new Error(`Market ${config.marketId} is not initialized on base`);
  if (!baseMarketInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("Market is not delegated; live ER reads are unavailable");
  }

  const marketRoute = await getDelegationStatus(
    config.routerEndpoint,
    marketAddress.toBase58(),
  );
  if (!marketRoute.isDelegated || !marketRoute.fqdn) {
    throw new Error("Router did not return an active ER for the Market");
  }
  const erEndpoint = normalizeErEndpoint(marketRoute.fqdn);
  const erConnection = new Connection(erEndpoint, "confirmed");
  const erMarketInfo = await erConnection.getAccountInfo(marketAddress, "confirmed");
  if (!erMarketInfo || !erMarketInfo.owner.equals(config.programId)) {
    throw new Error("Market is missing or has the wrong owner on its routed ER");
  }
  const market = decodeMarket(Buffer.from(erMarketInfo.data));
  if (market.marketId !== config.marketId) throw new Error("Routed Market ID mismatch");

  const oracleAddress = new PublicKey(market.oracle);
  const oracleInfo = await erConnection.getAccountInfo(oracleAddress, "confirmed");
  if (!oracleInfo || !oracleInfo.owner.equals(ORACLE_PROGRAM_ID)) {
    throw new Error("Configured oracle is missing or owned by the wrong program on the ER");
  }
  const price = decodeOraclePrice(
    Buffer.from(oracleInfo.data),
    market.oracleFeedId,
    Math.floor(now / 1_000),
  );

  let walletBalanceUsd: number | null = null;
  let fallbackClaimableUsd = 0;
  let plays: Play[] = [];
  let normalizedWallet: string | null = null;
  if (walletAddress) {
    const user = new PublicKey(walletAddress);
    normalizedWallet = user.toBase58();
    const positionsAddress = userPositionsPda(config.programId, user);
    const positionsRoute = await getDelegationStatus(
      config.routerEndpoint,
      positionsAddress.toBase58(),
    ).catch(() => null);
    if (positionsRoute?.isDelegated && positionsRoute.fqdn) {
      const positionsEndpoint = normalizeErEndpoint(positionsRoute.fqdn);
      if (positionsEndpoint !== erEndpoint) {
        throw new Error("UserPositions and Market are routed to different ERs");
      }
      const positionsInfo = await erConnection.getAccountInfo(positionsAddress, "confirmed");
      if (positionsInfo) {
        if (!positionsInfo.owner.equals(config.programId)) {
          throw new Error("UserPositions has the wrong owner on the ER");
        }
        plays = decodeUserPositions(Buffer.from(positionsInfo.data))
          .filter((position) => position.marketId === config.marketId)
          .map((position) => toPlay(position, now, price.displayPrice));
      }
    }

    const configInfo = await baseConnection.getAccountInfo(
      protocolConfigPda(config.programId),
      "confirmed",
    );
    if (configInfo) {
      const protocol = decodeProtocolConfig(Buffer.from(configInfo.data));
      const collateralMint = config.collateralMint ?? new PublicKey(protocol.collateralMint);
      const userTokenAccount = getAssociatedTokenAddressSync(collateralMint, user);
      const payoutEscrowTokenAccount = getAssociatedTokenAddressSync(
        collateralMint,
        positionsAddress,
        true,
      );
      const [tokenBalance, payoutBalance] = await Promise.all([
        erConnection.getTokenAccountBalance(userTokenAccount, "confirmed").catch(() => null),
        erConnection.getTokenAccountBalance(payoutEscrowTokenAccount, "confirmed").catch(() => null),
      ]);
      walletBalanceUsd = tokenBalance?.value.uiAmount ?? null;
      fallbackClaimableUsd = payoutBalance?.value.uiAmount ?? 0;
    }
  }

  return {
    mode: "live",
    marketId: market.marketId,
    marketLabel: "BTC / USD",
    gameLabel: "BTC PRICE RUSH",
    currentPrice: price.displayPrice,
    priceExponent: ORACLE_EXPONENT,
    priceHistory: updateHistory(oracleAddress.toBase58(), price.displayPrice, now),
    feedHealth: "live",
    feedAgeSeconds: price.ageSeconds,
    marketMode: market.mode,
    activePositions: market.activePositions,
    maxPositions: 8,
    walletAddress: normalizedWallet,
    walletBalanceUsd,
    fallbackClaimableUsd,
    plays,
    capturedAt: now,
    erEndpoint,
    notice: "Live mode · wallet-signed plays enabled",
  };
}
