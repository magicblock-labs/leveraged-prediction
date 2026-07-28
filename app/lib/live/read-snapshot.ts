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
} from "@/app/lib/live/decode";
import { ORACLE_PROGRAM_ID, readLiveConfig } from "@/app/lib/live/config";
import {
  decodeOraclePrice,
  ORACLE_EXPONENT,
} from "@/app/lib/live/oracle";
import { mergeOraclePriceHistory } from "@/app/lib/live/oracle-stream";
import {
  marketPda,
  protocolConfigPda,
  userPositionsPda,
} from "@/app/lib/live/pdas";
import {
  getDelegationStatus,
  normalizeErEndpoint,
} from "@/app/lib/live/router";
import { positionToPlay } from "@/app/lib/live/position-stream";
import { Buffer } from "buffer";

const historyByOracle = new Map<string, PricePoint[]>();

function updateHistory(oracle: string, price: number, now: number): PricePoint[] {
  const current = historyByOracle.get(oracle) ?? [];
  const next = mergeOraclePriceHistory(
    current,
    [{ price, timestamp: now }],
    now,
  );
  historyByOracle.set(oracle, next);
  return next;
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
  let collateralMintAddress: string | undefined;
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
          .map((position) => positionToPlay(position, now, price.displayPrice));
      }
    }

    const configInfo = await baseConnection.getAccountInfo(
      protocolConfigPda(config.programId),
      "confirmed",
    );
    if (configInfo) {
      const protocol = decodeProtocolConfig(Buffer.from(configInfo.data));
      const collateralMint = config.collateralMint ?? new PublicKey(protocol.collateralMint);
      collateralMintAddress = collateralMint.toBase58();
      const userTokenAccount = getAssociatedTokenAddressSync(collateralMint, user);
      const payoutEscrowTokenAccount = getAssociatedTokenAddressSync(
        collateralMint,
        positionsAddress,
        true,
      );
      const [erTokenBalance, payoutBalance] = await Promise.all([
        erConnection.getTokenAccountBalance(userTokenAccount, "confirmed").catch(() => null),
        erConnection.getTokenAccountBalance(payoutEscrowTokenAccount, "confirmed").catch(() => null),
      ]);
      walletBalanceUsd = erTokenBalance?.value.uiAmount ?? null;
      fallbackClaimableUsd = payoutBalance?.value.uiAmount ?? 0;
    }
  }

  return {
    mode: "live",
    marketId: market.marketId,
    marketLabel: "BTC / USD",
    gameLabel: "BTC PRICE RUSH",
    currentPrice: price.displayPrice,
    currentRawPrice: price.rawPrice.toString(),
    priceExponent: ORACLE_EXPONENT,
    priceHistory: updateHistory(oracleAddress.toBase58(), price.displayPrice, now),
    feedHealth: "live",
    feedAgeSeconds: price.ageSeconds,
    marketMode: market.mode,
    activePositions: market.activePositions,
    nextPositionNonce: market.nextPositionNonce,
    maxPositions: 8,
    walletAddress: normalizedWallet,
    walletBalanceUsd,
    fallbackClaimableUsd,
    plays,
    capturedAt: now,
    erEndpoint,
    collateralMint: collateralMintAddress,
    oracleAddress: oracleAddress.toBase58(),
    oracleFeedId: Buffer.from(market.oracleFeedId).toString("hex"),
    notice: "Live mode · oracle websocket ready",
  };
}
