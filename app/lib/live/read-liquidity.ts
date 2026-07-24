import {
  DELEGATION_PROGRAM_ID,
  deriveEphemeralAta,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { LiquiditySnapshot } from "@/app/lib/liquidity";
import { assetsForShares } from "@/app/lib/liquidity";
import {
  decodeMarket,
  decodeProtocolConfig,
  decodeUserLiquidity,
} from "@/app/lib/live/decode";
import { readLiveConfig } from "@/app/lib/live/config";
import {
  marketPda,
  protocolConfigPda,
  userLiquidityPda,
} from "@/app/lib/live/pdas";
import {
  getDelegationStatus,
  normalizeErEndpoint,
} from "@/app/lib/live/router";
import { Buffer } from "buffer";

export async function readLiquiditySnapshot(
  walletAddress?: string,
): Promise<LiquiditySnapshot> {
  const config = readLiveConfig();
  const capturedAt = Date.now();
  const baseConnection = new Connection(config.baseRpcEndpoint, "confirmed");
  const marketAddress = marketPda(config.programId, config.marketId);
  const baseMarketInfo = await baseConnection.getAccountInfo(marketAddress, "confirmed");
  if (!baseMarketInfo?.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("Market is not delegated; liquidity reads are unavailable");
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
  if (!erMarketInfo?.owner.equals(config.programId)) {
    throw new Error("Market is missing or has the wrong owner on its routed ER");
  }
  const market = decodeMarket(Buffer.from(erMarketInfo.data));
  if (market.marketId !== config.marketId) {
    throw new Error("Routed Market ID mismatch");
  }

  const protocolAddress = protocolConfigPda(config.programId);
  const protocolInfo = await baseConnection.getAccountInfo(protocolAddress, "confirmed");
  if (!protocolInfo?.owner.equals(config.programId)) {
    throw new Error("ProtocolConfig is missing or has the wrong owner");
  }
  const protocol = decodeProtocolConfig(Buffer.from(protocolInfo.data));
  const collateralMint = config.collateralMint ?? new PublicKey(protocol.collateralMint);
  const poolTokenAccount = getAssociatedTokenAddressSync(
    collateralMint,
    marketAddress,
    true,
  );
  const pool = await getAccount(erConnection, poolTokenAccount, "confirmed");
  if (
    !pool.owner.equals(marketAddress) ||
    !pool.mint.equals(collateralMint)
  ) {
    throw new Error("Market pool token account owner or mint mismatch");
  }

  let walletBalanceMinor: bigint | null = null;
  let baseWalletBalanceMinor: bigint | null = null;
  let erWalletBalanceMinor: bigint | null = null;
  let userShares = 0n;
  let pendingWithdrawalShares = 0n;
  let pendingMinAssetsOut = 0n;
  let userLiquidityStatus: LiquiditySnapshot["userLiquidityStatus"] = "not-created";

  if (walletAddress) {
    const user = new PublicKey(walletAddress);
    const userTokenAccount = getAssociatedTokenAddressSync(collateralMint, user);
    const [ephemeralTokenAccount] = deriveEphemeralAta(user, collateralMint);
    const baseToken = await getAccount(
      baseConnection,
      userTokenAccount,
      "confirmed",
    ).catch(() => null);
    if (baseToken) {
      if (!baseToken.owner.equals(user) || !baseToken.mint.equals(collateralMint)) {
        throw new Error("Wallet token account owner or mint mismatch on base");
      }
      baseWalletBalanceMinor = baseToken.amount;
    }

    const tokenRoutes = await Promise.all(
      [ephemeralTokenAccount, userTokenAccount].map((address) =>
        getDelegationStatus(config.routerEndpoint, address.toBase58()).catch(() => null),
      ),
    );
    const tokenRoute = tokenRoutes.find((route) => route?.isDelegated && route.fqdn);
    if (tokenRoute?.fqdn) {
      const tokenEndpoint = normalizeErEndpoint(tokenRoute.fqdn);
      if (tokenEndpoint !== erEndpoint) {
        throw new Error("Wallet collateral and Market are routed to different ERs");
      }
      const erToken = await getAccount(
        erConnection,
        userTokenAccount,
        "confirmed",
      ).catch(() => null);
      if (erToken) {
        if (!erToken.owner.equals(user) || !erToken.mint.equals(collateralMint)) {
          throw new Error("Wallet token account owner or mint mismatch on the ER");
        }
        erWalletBalanceMinor = erToken.amount;
      }
    }
    walletBalanceMinor =
      (baseWalletBalanceMinor ?? 0n) + (erWalletBalanceMinor ?? 0n);

    const liquidityAddress = userLiquidityPda(config.programId, user);
    const baseLiquidityInfo = await baseConnection.getAccountInfo(
      liquidityAddress,
      "confirmed",
    );
    if (baseLiquidityInfo?.owner.equals(DELEGATION_PROGRAM_ID)) {
      const route = await getDelegationStatus(
        config.routerEndpoint,
        liquidityAddress.toBase58(),
      );
      if (!route.isDelegated || !route.fqdn) {
        throw new Error("UserLiquidity is delegated but has no active route");
      }
      if (normalizeErEndpoint(route.fqdn) !== erEndpoint) {
        throw new Error("UserLiquidity and Market are routed to different ERs");
      }
      const erLiquidityInfo = await erConnection.getAccountInfo(
        liquidityAddress,
        "confirmed",
      );
      if (!erLiquidityInfo?.owner.equals(config.programId)) {
        throw new Error("UserLiquidity is missing or has the wrong owner on the ER");
      }
      const entry = decodeUserLiquidity(Buffer.from(erLiquidityInfo.data))
        .find((candidate) => candidate.marketId === config.marketId);
      userShares = entry?.shares ?? 0n;
      pendingWithdrawalShares = entry?.pendingWithdrawalShares ?? 0n;
      pendingMinAssetsOut = entry?.minAssetsOut ?? 0n;
      userLiquidityStatus = "ready";
    } else if (baseLiquidityInfo?.owner.equals(config.programId)) {
      userLiquidityStatus = "needs-delegation";
    } else if (baseLiquidityInfo) {
      throw new Error("UserLiquidity has an unexpected base-layer owner");
    }
  }

  return {
    marketId: market.marketId,
    marketLabel: "BTC / USD",
    marketMode: market.mode,
    activePositions: market.activePositions,
    totalShares: market.totalShares.toString(),
    poolBalanceMinor: pool.amount.toString(),
    walletBalanceMinor: walletBalanceMinor?.toString() ?? null,
    baseWalletBalanceMinor: baseWalletBalanceMinor?.toString() ?? null,
    erWalletBalanceMinor: erWalletBalanceMinor?.toString() ?? null,
    userShares: userShares.toString(),
    pendingWithdrawalShares: pendingWithdrawalShares.toString(),
    pendingMinAssetsOutMinor: pendingMinAssetsOut.toString(),
    currentValueMinor: assetsForShares(
      userShares,
      pool.amount,
      market.totalShares,
    ).toString(),
    userLiquidityStatus,
    erEndpoint,
    collateralMint: collateralMint.toBase58(),
    capturedAt,
  };
}
