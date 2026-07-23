import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const BASE_RPC = process.env.SOLANA_RPC_ENDPOINT ?? "https://rpc.magicblock.app/devnet";
const ER_RPC = process.env.EPHEMERAL_RPC_ENDPOINT ?? "https://devnet-as.magicblock.app";
const PROGRAM_ID = new PublicKey("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");
const HYDRA_PROGRAM_ID = new PublicKey("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const SESSION_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const BTC_ORACLE = new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const BTC_FEED_ID = Buffer.from("59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65", "hex");
const MARKET_ID = 1;
const MINIMUM_LIQUIDITY = 100_000_000_000n;

function expandHome(path) {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

async function loadKeypair(path) {
  const secret = JSON.parse(await readFile(expandHome(path), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function marketPda() {
  const id = Buffer.alloc(2);
  id.writeUInt16LE(MARKET_ID);
  return PublicKey.findProgramAddressSync([Buffer.from("market"), id], PROGRAM_ID)[0];
}

function protocolConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], PROGRAM_ID)[0];
}

function decodeOracle(data) {
  if (data.length < 133 || data[40] !== 1) throw new Error("BTC oracle is not a full PriceUpdateV2");
  const feed = data.subarray(41, 73);
  if (!feed.equals(BTC_FEED_ID)) throw new Error("BTC oracle feed ID changed");
  const price = data.readBigInt64LE(73);
  const confidence = data.readBigUInt64LE(81);
  const exponent = data.readInt32LE(89);
  const publishTime = Number(data.readBigInt64LE(93));
  const postedSlot = data.readBigUInt64LE(125);
  if (price <= 0n || exponent !== 8 || postedSlot === 0n) throw new Error("BTC oracle payload is invalid");
  if (confidence * 10_000n > price) throw new Error("BTC oracle confidence exceeds one basis point");
  return { price: Number(price) / 100_000_000, publishTime, postedSlot: postedSlot.toString() };
}

function decodeConfig(data) {
  if (data.length < 105) throw new Error("ProtocolConfig is truncated");
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    collateralMint: new PublicKey(data.subarray(72, 104)),
  };
}

function decodeMarket(data) {
  if (data.length < 116) throw new Error("Market is truncated");
  return {
    oracle: new PublicKey(data.subarray(10, 42)),
    feedId: data.subarray(42, 74),
    totalShares: data.readBigUInt64LE(74) + (data.readBigUInt64LE(82) << 64n),
  };
}

const base = new Connection(BASE_RPC, "confirmed");
const er = new Connection(ER_RPC, "confirmed");
const walletPath = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
const wallet = await loadKeypair(walletPath);
const binaryPath = resolve("target/deploy/leveraged_prediction.so");
const binarySize = (await readFile(binaryPath)).byteLength;
const requiredProgramRent = await base.getMinimumBalanceForRentExemption(binarySize);
const protocolAddress = protocolConfigPda();
const marketAddress = marketPda();

const [walletLamports, appProgram, sessionProgram, hydraProgram, oracle, protocolConfig, market] = await Promise.all([
  base.getBalance(wallet.publicKey, "confirmed"),
  base.getAccountInfo(PROGRAM_ID, "confirmed"),
  base.getAccountInfo(SESSION_PROGRAM_ID, "confirmed"),
  er.getAccountInfo(HYDRA_PROGRAM_ID, "confirmed"),
  er.getAccountInfo(BTC_ORACLE, "confirmed"),
  base.getAccountInfo(protocolAddress, "confirmed"),
  er.getAccountInfo(marketAddress, "confirmed"),
]);

if (!oracle || !oracle.owner.equals(ORACLE_PROGRAM_ID)) {
  throw new Error("Canonical BTC oracle is missing or has the wrong owner");
}
const oracleState = decodeOracle(Buffer.from(oracle.data));
const configState = protocolConfig ? decodeConfig(Buffer.from(protocolConfig.data)) : null;
const marketState = market ? decodeMarket(Buffer.from(market.data)) : null;
const collateralMint = configState?.collateralMint ?? null;
const poolTokenAccount = collateralMint
  ? getAssociatedTokenAddressSync(collateralMint, marketAddress, true)
  : null;
const walletTokenAccount = collateralMint
  ? getAssociatedTokenAddressSync(collateralMint, wallet.publicKey)
  : null;

const [mintState, poolBalance, walletBalance] = collateralMint && poolTokenAccount && walletTokenAccount
  ? await Promise.all([
      getMint(base, collateralMint, "confirmed").catch(() => null),
      er.getTokenAccountBalance(poolTokenAccount, "confirmed").catch(() => null),
      er.getTokenAccountBalance(walletTokenAccount, "confirmed").catch(() => null),
    ])
  : [null, null, null];
const poolAmount = BigInt(poolBalance?.value.amount ?? 0);

const blockers = [];
if (!appProgram?.executable && walletLamports < requiredProgramRent + 50_000_000) {
  blockers.push(`deployment wallet needs about ${((requiredProgramRent + 50_000_000 - walletLamports) / 1_000_000_000).toFixed(3)} more SOL`);
}
if (!appProgram?.executable) blockers.push("leveraged-prediction program is not deployed");
if (!sessionProgram?.executable) blockers.push("Session Keys program is absent on the base layer");
if (!hydraProgram?.executable) blockers.push("ephemeral Hydra program is absent on the target ER");
if (!protocolConfig || !configState) blockers.push("ProtocolConfig is not initialized");
if (configState && !configState.admin.equals(wallet.publicKey)) blockers.push("ProtocolConfig admin does not match deployment wallet");
if (!mintState || mintState.decimals !== 6) blockers.push("configured test-USDC mint is missing or is not six-decimal");
if (!market || !marketState) blockers.push(`Market ${MARKET_ID} is not initialized on the target ER`);
if (market && !market.owner.equals(PROGRAM_ID)) blockers.push("Market has the wrong owner on the target ER");
if (marketState && (!marketState.oracle.equals(BTC_ORACLE) || !marketState.feedId.equals(BTC_FEED_ID))) {
  blockers.push("Market oracle configuration does not match canonical BTC");
}
if (poolAmount < MINIMUM_LIQUIDITY) {
  blockers.push(`BTC pool needs ${(Number(MINIMUM_LIQUIDITY - poolAmount) / 1_000_000).toFixed(2)} more test USDC for minimum liquidity`);
}
const baseMarket = await base.getAccountInfo(marketAddress, "confirmed");
if (baseMarket && !baseMarket.owner.equals(DELEGATION_PROGRAM_ID)) blockers.push("Market is not delegated on base");

console.log(JSON.stringify({
  ready: blockers.length === 0,
  endpoints: { base: BASE_RPC, er: ER_RPC },
  wallet: wallet.publicKey.toBase58(),
  walletSol: walletLamports / 1_000_000_000,
  program: {
    address: PROGRAM_ID.toBase58(),
    deployed: Boolean(appProgram?.executable),
    binarySize,
    requiredProgramRent: requiredProgramRent / 1_000_000_000,
  },
  sessionKeys: {
    address: SESSION_PROGRAM_ID.toBase58(),
    deployed: Boolean(sessionProgram?.executable),
  },
  hydra: { address: HYDRA_PROGRAM_ID.toBase58(), deployed: Boolean(hydraProgram?.executable) },
  oracle: { address: BTC_ORACLE.toBase58(), feedId: BTC_FEED_ID.toString("hex"), ...oracleState },
  collateral: {
    mint: collateralMint?.toBase58() ?? null,
    decimals: mintState?.decimals ?? null,
    walletBalance: walletBalance?.value.uiAmount ?? null,
    poolTokenAccount: poolTokenAccount?.toBase58() ?? null,
    poolBalance: poolBalance?.value.uiAmount ?? null,
    minimumLiquidity: Number(MINIMUM_LIQUIDITY) / 1_000_000,
  },
  accounts: {
    protocolConfig: protocolAddress.toBase58(),
    protocolConfigExists: Boolean(protocolConfig),
    market: marketAddress.toBase58(),
    marketExists: Boolean(market),
    marketTotalShares: marketState?.totalShares.toString() ?? null,
  },
  blockers,
}, null, 2));

if (blockers.length > 0) process.exitCode = 2;
