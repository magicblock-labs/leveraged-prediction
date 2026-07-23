import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/app/lib/live/config";

export interface ClientLiveConfig {
  baseRpcEndpoint: string;
  routerEndpoint: string;
  erStreamRpcEndpoint?: string;
  erStreamWsEndpoint?: string;
  sessionSetupLookupTable?: PublicKey;
  programId: PublicKey;
  marketId: number;
}

export function readClientLiveConfig(): ClientLiveConfig {
  const marketId = Number(
    process.env.NEXT_PUBLIC_LEVERAGED_PREDICTION_MARKET_ID ?? "1",
  );
  if (!Number.isInteger(marketId) || marketId < 0 || marketId > 65_535) {
    throw new Error("NEXT_PUBLIC_LEVERAGED_PREDICTION_MARKET_ID must be a u16");
  }

  return {
    baseRpcEndpoint:
      process.env.NEXT_PUBLIC_SOLANA_RPC_ENDPOINT ??
      "https://rpc.magicblock.app/devnet",
    routerEndpoint:
      process.env.NEXT_PUBLIC_ROUTER_ENDPOINT ??
      "https://devnet-router.magicblock.app/",
    erStreamRpcEndpoint: process.env.NEXT_PUBLIC_ER_STREAM_RPC_ENDPOINT,
    erStreamWsEndpoint: process.env.NEXT_PUBLIC_ER_STREAM_WS_ENDPOINT,
    sessionSetupLookupTable: process.env.NEXT_PUBLIC_SESSION_SETUP_LOOKUP_TABLE
      ? new PublicKey(process.env.NEXT_PUBLIC_SESSION_SETUP_LOOKUP_TABLE)
      : undefined,
    programId: new PublicKey(
      process.env.NEXT_PUBLIC_LEVERAGED_PREDICTION_PROGRAM_ID ??
        DEFAULT_PROGRAM_ID,
    ),
    marketId,
  };
}
