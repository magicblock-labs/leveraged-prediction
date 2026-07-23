import { PublicKey } from "@solana/web3.js";

export const DEFAULT_PROGRAM_ID = new PublicKey(
  "AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr",
);

export const ORACLE_PROGRAM_ID = new PublicKey(
  "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd",
);

export interface LiveConfig {
  baseRpcEndpoint: string;
  routerEndpoint: string;
  programId: PublicKey;
  marketId: number;
  collateralMint?: PublicKey;
}

export function readLiveConfig(): LiveConfig {
  const marketId = Number(process.env.LEVERAGED_PREDICTION_MARKET_ID ?? "1");
  if (!Number.isInteger(marketId) || marketId < 0 || marketId > 65_535) {
    throw new Error("LEVERAGED_PREDICTION_MARKET_ID must be a u16");
  }

  const programId = new PublicKey(
    process.env.LEVERAGED_PREDICTION_PROGRAM_ID ?? DEFAULT_PROGRAM_ID,
  );
  const collateralMint = process.env.LEVERAGED_PREDICTION_COLLATERAL_MINT
    ? new PublicKey(process.env.LEVERAGED_PREDICTION_COLLATERAL_MINT)
    : undefined;

  return {
    baseRpcEndpoint:
      process.env.SOLANA_RPC_ENDPOINT ??
      process.env.NEXT_PUBLIC_SOLANA_RPC_ENDPOINT ??
      "https://rpc.magicblock.app/devnet",
    routerEndpoint:
      process.env.ROUTER_ENDPOINT ??
      process.env.NEXT_PUBLIC_ROUTER_ENDPOINT ??
      "https://devnet-router.magicblock.app/",
    programId,
    marketId,
    collateralMint,
  };
}
