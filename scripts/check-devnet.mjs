import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const BASE_RPC = process.env.SOLANA_RPC_ENDPOINT ?? "https://rpc.magicblock.app/devnet";
const ER_RPC = process.env.EPHEMERAL_RPC_ENDPOINT ?? "https://devnet.magicblock.app";
const PROGRAM_ID = new PublicKey("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");
const HYDRA_PROGRAM_ID = new PublicKey("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const BTC_ORACLE = new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const BTC_FEED_ID = Buffer.from("59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65", "hex");
const CIRCLE_DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
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

const base = new Connection(BASE_RPC, "confirmed");
const er = new Connection(ER_RPC, "confirmed");
const walletPath = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
const wallet = await loadKeypair(walletPath);
const binaryPath = resolve("target/deploy/leveraged_prediction.so");
const binarySize = (await readFile(binaryPath)).byteLength;
const requiredProgramRent = await base.getMinimumBalanceForRentExemption(binarySize);

const [walletLamports, appProgram, hydraProgram, oracle, protocolConfig, market] = await Promise.all([
  base.getBalance(wallet.publicKey, "confirmed"),
  base.getAccountInfo(PROGRAM_ID, "confirmed"),
  er.getAccountInfo(HYDRA_PROGRAM_ID, "confirmed"),
  er.getAccountInfo(BTC_ORACLE, "confirmed"),
  base.getAccountInfo(protocolConfigPda(), "confirmed"),
  base.getAccountInfo(marketPda(), "confirmed"),
]);

if (!oracle || !oracle.owner.equals(ORACLE_PROGRAM_ID)) {
  throw new Error("Canonical BTC oracle is missing or has the wrong owner");
}
const oracleState = decodeOracle(Buffer.from(oracle.data));
const usdcAta = getAssociatedTokenAddressSync(CIRCLE_DEVNET_USDC, wallet.publicKey);
const usdcBalance = await base.getTokenAccountBalance(usdcAta, "confirmed")
  .then((value) => BigInt(value.value.amount))
  .catch(() => 0n);

const blockers = [];
if (!appProgram && walletLamports < requiredProgramRent + 50_000_000) {
  blockers.push(`deployment wallet needs about ${((requiredProgramRent + 50_000_000 - walletLamports) / 1_000_000_000).toFixed(3)} more SOL`);
}
if (!hydraProgram?.executable) blockers.push("ephemeral Hydra program is absent on the target ER");
if (!protocolConfig) blockers.push("ProtocolConfig is not initialized");
if (!market) blockers.push(`Market ${MARKET_ID} is not initialized`);
if (usdcBalance < MINIMUM_LIQUIDITY) {
  blockers.push(`deployment wallet needs ${(Number(MINIMUM_LIQUIDITY - usdcBalance) / 1_000_000).toFixed(2)} more Circle devnet USDC for minimum liquidity`);
}

console.log(JSON.stringify({
  ready: blockers.length === 0,
  endpoints: { base: BASE_RPC, er: ER_RPC },
  wallet: wallet.publicKey.toBase58(),
  walletSol: walletLamports / 1_000_000_000,
  program: { address: PROGRAM_ID.toBase58(), deployed: Boolean(appProgram?.executable), binarySize, requiredProgramRent: requiredProgramRent / 1_000_000_000 },
  hydra: { address: HYDRA_PROGRAM_ID.toBase58(), deployed: Boolean(hydraProgram?.executable) },
  oracle: { address: BTC_ORACLE.toBase58(), feedId: BTC_FEED_ID.toString("hex"), ...oracleState },
  collateral: { mint: CIRCLE_DEVNET_USDC.toBase58(), walletBalance: Number(usdcBalance) / 1_000_000, minimumLiquidity: Number(MINIMUM_LIQUIDITY) / 1_000_000 },
  accounts: { protocolConfig: protocolConfigPda().toBase58(), protocolConfigExists: Boolean(protocolConfig), market: marketPda().toBase58(), marketExists: Boolean(market) },
  blockers,
}, null, 2));

if (blockers.length > 0) process.exitCode = 2;
