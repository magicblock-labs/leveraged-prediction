import * as anchor from "@coral-xyz/anchor";
import {
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  deriveRentPda,
  deriveVault,
  deriveVaultAta,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const BASE_RPC = process.env.SOLANA_RPC_ENDPOINT ?? "https://rpc.magicblock.app/devnet";
const ER_RPC = process.env.EPHEMERAL_RPC_ENDPOINT ?? "https://devnet-as.magicblock.app";
const ROUTER_RPC = process.env.ROUTER_ENDPOINT ?? "https://devnet.magicblock.app";
const PROGRAM_ID = new PublicKey("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");
const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const BTC_ORACLE = new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const BTC_FEED_ID = Buffer.from("59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65", "hex");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MARKET_ID = 1;
const LIQUIDITY = 101_000_000_000n;
const WALLET_FLOAT = 1_000_000_000n;
const SPONSOR_LAMPORTS = 1_000_000;
const DEPLOYMENT_DIR = resolve(".devnet");
const MINT_KEYPAIR_PATH = resolve(DEPLOYMENT_DIR, "test-usdc-mint-keypair.json");
const MANIFEST_PATH = resolve(DEPLOYMENT_DIR, "market-1.json");
const SESSION_SETUP_LOOKUP_TABLE_PATH = resolve(
  DEPLOYMENT_DIR,
  "session-setup-lookup-table.json",
);

function protocolConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], PROGRAM_ID)[0];
}

function marketPda() {
  const marketId = Buffer.alloc(2);
  marketId.writeUInt16LE(MARKET_ID);
  return PublicKey.findProgramAddressSync([Buffer.from("market"), marketId], PROGRAM_ID)[0];
}

function feeAuthorityPda(market) {
  return PublicKey.findProgramAddressSync([Buffer.from("fee_authority"), market.toBuffer()], PROGRAM_ID)[0];
}

function userLiquidityPda(user) {
  return PublicKey.findProgramAddressSync([Buffer.from("user_liquidity"), user.toBuffer()], PROGRAM_ID)[0];
}

async function loadKeypair(path) {
  const secret = JSON.parse(await readFile(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function loadOrCreateMintKeypair() {
  try {
    return await loadKeypair(MINT_KEYPAIR_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const keypair = Keypair.generate();
  await writeFile(MINT_KEYPAIR_PATH, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return keypair;
}

async function sendTransaction(connection, transaction, payer) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(payer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return signature;
}

async function ensureSessionSetupLookupTable(connection, admin, addresses) {
  let lookupTableAddress;
  try {
    const stored = JSON.parse(
      await readFile(SESSION_SETUP_LOOKUP_TABLE_PATH, "utf8"),
    );
    lookupTableAddress = new PublicKey(stored.address);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let lookupTable = lookupTableAddress
    ? (await connection.getAddressLookupTable(lookupTableAddress, {
        commitment: "confirmed",
      })).value
    : null;
  if (!lookupTable) {
    const recentSlot = await connection.getSlot("finalized");
    const [createInstruction, derivedAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: admin.publicKey,
        payer: admin.publicKey,
        recentSlot,
      });
    const signature = await sendTransaction(
      connection,
      new Transaction().add(createInstruction),
      admin,
    );
    lookupTableAddress = derivedAddress;
    console.log(
      `Created session setup lookup table ${lookupTableAddress}: ${signature}`,
    );
    await eventually("session setup lookup table creation", async () => {
      lookupTable = (await connection.getAddressLookupTable(
        lookupTableAddress,
        { commitment: "confirmed" },
      )).value;
      return lookupTable !== null;
    });
  }
  if (!lookupTable) throw new Error("Session setup lookup table was not created");
  if (!lookupTable.state.authority?.equals(admin.publicKey)) {
    throw new Error("Session setup lookup table has an unexpected authority");
  }

  const existing = new Set(
    lookupTable.state.addresses.map((address) => address.toBase58()),
  );
  const missing = addresses.filter(
    (address) => !existing.has(address.toBase58()),
  );
  if (missing.length > 0) {
    const signature = await sendTransaction(
      connection,
      new Transaction().add(
        AddressLookupTableProgram.extendLookupTable({
          authority: admin.publicKey,
          payer: admin.publicKey,
          lookupTable: lookupTableAddress,
          addresses: missing,
        }),
      ),
      admin,
    );
    console.log(
      `Extended session setup lookup table with ${missing.length} addresses: ${signature}`,
    );
  }
  await writeFile(
    SESSION_SETUP_LOOKUP_TABLE_PATH,
    `${JSON.stringify({ address: lookupTableAddress.toBase58() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return lookupTableAddress;
}

async function getDelegationStatus(account) {
  const response = await fetch(`${ROUTER_RPC.replace(/\/+$/, "")}/getDelegationStatus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `delegation-${account.toBase58()}`,
      method: "getDelegationStatus",
      params: [account.toBase58()],
    }),
  });
  if (!response.ok) throw new Error(`Router returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.result) throw new Error(body.error?.message ?? "Router returned no result");
  return body.result;
}

async function eventually(label, predicate, attempts = 180) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${String(lastError)}` : ""}`);
}

function decodeProtocolConfig(data) {
  if (data.length < 105) throw new Error("ProtocolConfig is truncated");
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    collateralMint: new PublicKey(data.subarray(72, 104)),
  };
}

function decodeMarket(data) {
  if (data.length < 116) throw new Error("Market is truncated");
  return {
    marketId: data.readUInt16LE(8),
    oracle: new PublicKey(data.subarray(10, 42)),
    feedId: data.subarray(42, 74),
    totalShares: data.readBigUInt64LE(74) + (data.readBigUInt64LE(82) << 64n),
  };
}

await mkdir(DEPLOYMENT_DIR, { recursive: true, mode: 0o700 });
const walletPath = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
const admin = await loadKeypair(walletPath);
const base = new Connection(BASE_RPC, "confirmed");
const er = new Connection(ER_RPC, "confirmed");
const idl = JSON.parse(await readFile(resolve("target/idl/leveraged_prediction.json"), "utf8"));
const baseProvider = new anchor.AnchorProvider(base, new anchor.Wallet(admin), {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const erProvider = new anchor.AnchorProvider(er, new anchor.Wallet(admin), {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new anchor.Program(idl, baseProvider);
const erProgram = new anchor.Program(idl, erProvider);

const identityResponse = await fetch(ER_RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
});
const identityBody = await identityResponse.json();
if (!identityBody.result?.identity) throw new Error(identityBody.error?.message ?? "ER identity is missing");
const validator = new PublicKey(identityBody.result.identity);

const [programInfo, oracleInfo] = await Promise.all([
  base.getAccountInfo(PROGRAM_ID, "confirmed"),
  er.getAccountInfo(BTC_ORACLE, "confirmed"),
]);
if (!programInfo?.executable) throw new Error(`Program ${PROGRAM_ID} is not deployed on devnet`);
if (!oracleInfo || !oracleInfo.owner.equals(ORACLE_PROGRAM_ID)) {
  throw new Error("Canonical BTC oracle is missing from the selected ER");
}
if (!Buffer.from(oracleInfo.data).subarray(41, 73).equals(BTC_FEED_ID)) {
  throw new Error("Canonical BTC oracle feed ID changed");
}

const mintKeypair = await loadOrCreateMintKeypair();
let mintInfo = await base.getAccountInfo(mintKeypair.publicKey, "confirmed");
if (!mintInfo) {
  await createMint(base, admin, admin.publicKey, null, 6, mintKeypair, { commitment: "confirmed" });
  console.log(`Created test USDC mint ${mintKeypair.publicKey}`);
} else {
  const mintState = await getMint(base, mintKeypair.publicKey, "confirmed");
  if (mintState.decimals !== 6 || !mintState.mintAuthority?.equals(admin.publicKey)) {
    throw new Error("Persisted test-USDC mint has unexpected configuration");
  }
}
const mint = mintKeypair.publicKey;
const [rentPda] = deriveRentPda();
const [vault] = deriveVault(mint);
const vaultAta = deriveVaultAta(mint, vault);
const sessionSetupLookupTable = await ensureSessionSetupLookupTable(
  base,
  admin,
  [mint, rentPda, vault, vaultAta],
);
const adminAta = await getOrCreateAssociatedTokenAccount(base, admin, mint, admin.publicKey, false, "confirmed");
const [adminEata] = deriveEphemeralAta(admin.publicKey, mint);
const targetSupply = LIQUIDITY + WALLET_FLOAT;
const userTokensDelegated = (await getDelegationStatus(adminEata)).isDelegated;
if (!userTokensDelegated && adminAta.amount < targetSupply) {
  await mintTo(base, admin, mint, adminAta.address, admin, targetSupply - adminAta.amount, [], { commitment: "confirmed" });
  console.log(`Minted ${Number(targetSupply - adminAta.amount) / 1_000_000} test USDC`);
}

const protocolConfig = protocolConfigPda();
const market = marketPda();
const feeAuthority = feeAuthorityPda(market);
const userLiquidity = userLiquidityPda(admin.publicKey);
const poolTokenAccount = getAssociatedTokenAddressSync(mint, market, true);
const feeTokenAccount = getAssociatedTokenAddressSync(mint, feeAuthority, true);
const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);

let protocolInfo = await base.getAccountInfo(protocolConfig, "confirmed");
if (!protocolInfo) {
  const signature = await program.methods.initializeProtocolConfig().accountsPartial({
    admin: admin.publicKey,
    feeAuthority: admin.publicKey,
    program: PROGRAM_ID,
    programData,
    collateralMint: mint,
    protocolConfig,
    systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(`Initialized ProtocolConfig: ${signature}`);
  protocolInfo = await base.getAccountInfo(protocolConfig, "confirmed");
}
const config = decodeProtocolConfig(Buffer.from(protocolInfo.data));
if (!config.admin.equals(admin.publicKey) || !config.collateralMint.equals(mint)) {
  throw new Error("Existing ProtocolConfig does not match this deployment wallet and mint");
}

let marketInfo = await base.getAccountInfo(market, "confirmed");
if (!marketInfo) {
  const signature = await program.methods.initializeMarket(
    MARKET_ID,
    BTC_ORACLE,
    Array.from(BTC_FEED_ID),
    new anchor.default.BN(SPONSOR_LAMPORTS),
  ).accountsPartial({
    admin: admin.publicKey,
    collateralMint: mint,
    protocolConfig,
    market,
    poolTokenAccount,
    derivedFeeAuthority: feeAuthority,
    feeTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(`Initialized BTC market ${MARKET_ID}: ${signature}`);
  marketInfo = await base.getAccountInfo(market, "confirmed");
}
const initialMarket = decodeMarket(Buffer.from(marketInfo.data));
if (initialMarket.marketId !== MARKET_ID || !initialMarket.oracle.equals(BTC_ORACLE) || !initialMarket.feedId.equals(BTC_FEED_ID)) {
  throw new Error("Existing market does not match the canonical BTC configuration");
}

if (!(await base.getAccountInfo(userLiquidity, "confirmed"))) {
  const signature = await program.methods.initializeUserLiquidity().accountsPartial({
    user: admin.publicKey,
    userLiquidity,
    systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(`Initialized deployer liquidity account: ${signature}`);
}

if (!(await getDelegationStatus(userLiquidity)).isDelegated) {
  const signature = await program.methods.delegateUserLiquidity(validator).accountsPartial({
    user: admin.publicKey,
    userLiquidity,
  }).rpc();
  console.log(`Delegated deployer liquidity account: ${signature}`);
}

if (!userTokensDelegated) {
  const instructions = await delegateSpl(admin.publicKey, mint, targetSupply, {
    payer: admin.publicKey,
    validator,
    idempotent: false,
    initVaultIfMissing: true,
  });
  const signature = await sendTransaction(base, new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...instructions,
  ), admin);
  console.log(`Delegated ${Number(targetSupply) / 1_000_000} test USDC: ${signature}`);
}

for (const [label, owner] of [
  ["pool", market],
  ["fee", feeAuthority],
]) {
  const [eata] = deriveEphemeralAta(owner, mint);
  if (!(await getDelegationStatus(eata)).isDelegated) {
    const signature = await sendTransaction(base, new Transaction().add(
      initEphemeralAtaIx(eata, owner, mint, admin.publicKey),
      delegateEphemeralAtaIx(admin.publicKey, eata, validator),
    ), admin);
    console.log(`Delegated ${label} token account: ${signature}`);
  }
}

if (!(await getDelegationStatus(market)).isDelegated) {
  const signature = await program.methods.delegateMarket(MARKET_ID, validator).accountsPartial({
    payer: admin.publicKey,
    protocolConfig,
    market,
  }).rpc();
  console.log(`Delegated BTC market: ${signature}`);
}

for (const [label, account] of [
  ["market", market],
  ["deployer liquidity", userLiquidity],
  ["deployer token", adminEata],
  ["pool token", deriveEphemeralAta(market, mint)[0]],
  ["fee token", deriveEphemeralAta(feeAuthority, mint)[0]],
]) {
  await eventually(`${label} route`, async () => (await getDelegationStatus(account)).isDelegated);
}
await eventually("ER token mirrors", async () => {
  const infos = await Promise.all([adminAta.address, poolTokenAccount, feeTokenAccount].map(
    (account) => er.getAccountInfo(account, "confirmed"),
  ));
  return infos.every((info) => info?.owner.equals(TOKEN_PROGRAM_ID));
});

const delegatedMarket = await er.getAccountInfo(market, "confirmed");
if (!delegatedMarket) throw new Error("Delegated market is missing on ER");
if (decodeMarket(Buffer.from(delegatedMarket.data)).totalShares === 0n) {
  const signature = await erProgram.methods.depositLiquidity(
    new anchor.default.BN(LIQUIDITY.toString()),
    new anchor.default.BN(0),
  ).accountsPartial({
    user: admin.publicKey,
    protocolConfig,
    market,
    userLiquidity,
    poolTokenAccount,
    userTokenAccount: adminAta.address,
    collateralMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  console.log(`Deposited ${Number(LIQUIDITY) / 1_000_000} test USDC: ${signature}`);
}

const [poolBalance, walletBalance, finalMarket] = await Promise.all([
  er.getTokenAccountBalance(poolTokenAccount, "confirmed"),
  er.getTokenAccountBalance(adminAta.address, "confirmed"),
  er.getAccountInfo(market, "confirmed"),
]);
const finalState = decodeMarket(Buffer.from(finalMarket.data));
if (BigInt(poolBalance.value.amount) < LIQUIDITY || finalState.totalShares === 0n) {
  throw new Error("Liquidity deposit did not reach the BTC pool");
}

const manifest = {
  cluster: "devnet",
  createdAt: new Date().toISOString(),
  endpoints: { base: BASE_RPC, er: ER_RPC, router: ROUTER_RPC },
  admin: admin.publicKey.toBase58(),
  validator: validator.toBase58(),
  program: PROGRAM_ID.toBase58(),
  collateralMint: mint.toBase58(),
  oracle: BTC_ORACLE.toBase58(),
  oracleFeedId: BTC_FEED_ID.toString("hex"),
  marketId: MARKET_ID,
  sessionSetupLookupTable: sessionSetupLookupTable.toBase58(),
  accounts: {
    protocolConfig: protocolConfig.toBase58(),
    market: market.toBase58(),
    poolTokenAccount: poolTokenAccount.toBase58(),
    feeTokenAccount: feeTokenAccount.toBase58(),
    deployerTokenAccount: adminAta.address.toBase58(),
    deployerLiquidity: userLiquidity.toBase58(),
  },
  balances: {
    poolTestUsdc: Number(poolBalance.value.amount) / 1_000_000,
    deployerTestUsdc: Number(walletBalance.value.amount) / 1_000_000,
  },
  totalShares: finalState.totalShares.toString(),
};
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
