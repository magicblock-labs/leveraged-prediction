import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readLiveConfig } from "@/app/lib/live/config";
import { decodeProtocolConfig } from "@/app/lib/live/decode";
import { marketPda, protocolConfigPda } from "@/app/lib/live/pdas";
import {
  getDelegationStatus,
  normalizeErEndpoint,
} from "@/app/lib/live/router";

export const DEVNET_FAUCET_SOL_LAMPORTS = 100_000_000;
export const DEVNET_FAUCET_USDC_MINOR = 100_000_000n;
const MAX_CONCURRENT_WALLETS = 4;
const inFlightFunding = new Map<string, Promise<DevnetFaucetResult>>();

export interface DevnetFaucetResult {
  ok: boolean;
  wallet: string;
  mint: string;
  targetSol: number;
  targetUsdc: number;
  balances: {
    sol: number;
    baseUsdc: number;
    erUsdc: number;
    totalUsdc: number;
  };
  added: {
    sol: number;
    usdc: number;
  };
  signatures: {
    sol: string | null;
    usdc: string | null;
  };
  errors: string[];
}

export function isTrustedDevnetRpc(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "api.devnet.solana.com") return url.pathname === "/";
    return url.hostname === "rpc.magicblock.app" && url.pathname.replace(/\/+$/, "") === "/devnet";
  } catch {
    return false;
  }
}

export function requiredTopUp(target: bigint, ...balances: bigint[]): bigint {
  const current = balances.reduce((sum, balance) => sum + balance, 0n);
  return current >= target ? 0n : target - current;
}

export function isDevnetFaucetEnabled(): boolean {
  const config = readLiveConfig();
  if (!isTrustedDevnetRpc(config.baseRpcEndpoint)) return false;
  if (process.env.DEVNET_FAUCET_ENABLED === "0") return false;
  if (process.env.DEVNET_FAUCET_ENABLED === "1") return true;
  return process.env.NODE_ENV !== "production";
}

export function devnetFaucetInfo() {
  return {
    enabled: isDevnetFaucetEnabled(),
    targetSol: DEVNET_FAUCET_SOL_LAMPORTS / LAMPORTS_PER_SOL,
    targetUsdc: Number(DEVNET_FAUCET_USDC_MINOR) / 1_000_000,
  };
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

async function loadAuthority(): Promise<Keypair> {
  const configuredPath =
    process.env.DEVNET_FAUCET_AUTHORITY_PATH ??
    process.env.ANCHOR_WALLET ??
    resolve(homedir(), ".config/solana/id.json");
  const secret = JSON.parse(await readFile(expandHome(configuredPath), "utf8")) as unknown;
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    !secret.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    throw new Error("Devnet faucet authority file is not a 64-byte Solana keypair");
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function readTokenAmount(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  return (await getAccount(connection, tokenAccount, "confirmed").catch(() => null))?.amount ?? 0n;
}

async function fundWallet(wallet: PublicKey): Promise<DevnetFaucetResult> {
  if (!isDevnetFaucetEnabled()) {
    throw new Error("The test-funds faucet is disabled or the configured RPC is not trusted devnet");
  }

  const config = readLiveConfig();
  const baseConnection = new Connection(config.baseRpcEndpoint, "confirmed");
  const protocolConfig = protocolConfigPda(config.programId);
  const market = marketPda(config.programId, config.marketId);
  const [protocolInfo, baseMarketInfo] = await Promise.all([
    baseConnection.getAccountInfo(protocolConfig, "confirmed"),
    baseConnection.getAccountInfo(market, "confirmed"),
  ]);
  if (!protocolInfo || !protocolInfo.owner.equals(config.programId)) {
    throw new Error("ProtocolConfig is missing or has the wrong owner");
  }
  if (!baseMarketInfo || !baseMarketInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("Market is not delegated on the base layer");
  }

  const collateralMint = new PublicKey(
    decodeProtocolConfig(Buffer.from(protocolInfo.data)).collateralMint,
  );
  const route = await getDelegationStatus(config.routerEndpoint, market.toBase58());
  if (!route.isDelegated || !route.fqdn) {
    throw new Error("Router did not return the active Market ER");
  }
  const erConnection = new Connection(normalizeErEndpoint(route.fqdn), "confirmed");
  const authority = await loadAuthority();
  const mintState = await getMint(baseConnection, collateralMint, "confirmed");
  if (
    mintState.decimals !== 6 ||
    !mintState.mintAuthority ||
    !mintState.mintAuthority.equals(authority.publicKey)
  ) {
    throw new Error("Configured faucet authority cannot mint the six-decimal collateral token");
  }

  const walletTokenAccount = getAssociatedTokenAddressSync(collateralMint, wallet);
  let [baseUsdc, erUsdc] = await Promise.all([
    readTokenAmount(baseConnection, walletTokenAccount),
    readTokenAmount(erConnection, walletTokenAccount),
  ]);
  let usdcSignature: string | null = null;
  let addedUsdc = 0n;
  const errors: string[] = [];

  try {
    const usdcShortfall = requiredTopUp(DEVNET_FAUCET_USDC_MINOR, baseUsdc, erUsdc);
    if (usdcShortfall > 0n) {
      await getOrCreateAssociatedTokenAccount(
        baseConnection,
        authority,
        collateralMint,
        wallet,
        false,
        "confirmed",
      );
      usdcSignature = await mintTo(
        baseConnection,
        authority,
        collateralMint,
        walletTokenAccount,
        authority,
        usdcShortfall,
        [],
        { commitment: "confirmed" },
      );
      [baseUsdc, erUsdc] = await Promise.all([
        readTokenAmount(baseConnection, walletTokenAccount),
        readTokenAmount(erConnection, walletTokenAccount),
      ]);
      addedUsdc = usdcShortfall;
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? `Test USDC: ${cause.message}` : "Test USDC funding failed");
  }

  let solSignature: string | null = null;
  let addedSolLamports = 0;
  let solLamports = await baseConnection.getBalance(wallet, "confirmed");
  try {
    const solShortfall = Math.max(0, DEVNET_FAUCET_SOL_LAMPORTS - solLamports);
    if (solShortfall > 0) {
      solSignature = await baseConnection.requestAirdrop(wallet, solShortfall);
      await baseConnection.confirmTransaction(solSignature, "confirmed");
      solLamports = await baseConnection.getBalance(wallet, "confirmed");
      addedSolLamports = solShortfall;
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? `Devnet SOL: ${cause.message}` : "Devnet SOL airdrop failed");
  }

  return {
    ok: errors.length === 0,
    wallet: wallet.toBase58(),
    mint: collateralMint.toBase58(),
    targetSol: DEVNET_FAUCET_SOL_LAMPORTS / LAMPORTS_PER_SOL,
    targetUsdc: Number(DEVNET_FAUCET_USDC_MINOR) / 1_000_000,
    balances: {
      sol: solLamports / LAMPORTS_PER_SOL,
      baseUsdc: Number(baseUsdc) / 1_000_000,
      erUsdc: Number(erUsdc) / 1_000_000,
      totalUsdc: Number(baseUsdc + erUsdc) / 1_000_000,
    },
    added: {
      sol: addedSolLamports / LAMPORTS_PER_SOL,
      usdc: Number(addedUsdc) / 1_000_000,
    },
    signatures: { sol: solSignature, usdc: usdcSignature },
    errors,
  };
}

export async function fundDevnetWallet(wallet: PublicKey): Promise<DevnetFaucetResult> {
  const key = wallet.toBase58();
  const existing = inFlightFunding.get(key);
  if (existing) return existing;
  if (inFlightFunding.size >= MAX_CONCURRENT_WALLETS) {
    throw new Error("The test-funds faucet is busy; try again in a few seconds");
  }
  const pending = fundWallet(wallet).finally(() => inFlightFunding.delete(key));
  inFlightFunding.set(key, pending);
  return pending;
}
