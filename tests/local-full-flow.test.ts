import * as anchor from "@coral-xyz/anchor";
import * as borsh from "@coral-xyz/borsh";
import {
  DELEGATION_PROGRAM_ID,
  delegateEphemeralAtaIx,
  delegateSpl,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  deriveEphemeralAta,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Signer,
} from "@solana/web3.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { decodeUserPositions } from "@/app/lib/live/decode";
import { clearOpenIntent } from "@/app/lib/live/intent-store";
import { subscribeOraclePrice } from "@/app/lib/live/oracle-stream";
import { feeAuthorityPda, marketPda, protocolConfigPda, userPositionsPda } from "@/app/lib/live/pdas";
import { readLiveSnapshot } from "@/app/lib/live/read-snapshot";
import { getDelegationStatus, normalizeErEndpoint } from "@/app/lib/live/router";
import {
  createGameSessionFlow,
  openPositionFlow,
  prepareOpenPosition,
  type SessionProgress,
  type TransactionProgress,
} from "@/app/lib/live/transaction-flow";
import {
  sessionKeypair,
  type StoredGameSession,
} from "@/app/lib/live/session-store";

const enabled = process.env.LOCAL_E2E === "1";
const suite = enabled ? describe : describe.skip;
const BASE_RPC = "http://127.0.0.1:8899";
const ER_RPC = "http://127.0.0.1:7799";
const ER_WS = "ws://127.0.0.1:7800";
const PUBLIC_RPC = "http://127.0.0.1:6699";
const PUBLIC_WS = "ws://127.0.0.1:6700";
const ROUTER_RPC = ER_RPC;
const MARKET_ID = 1;
const PROGRAM_ID = new PublicKey("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");
const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const ORACLE_ACCOUNT = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ORACLE_FEED_ID = Buffer.from("c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420", "hex");
const INITIAL_LIQUIDITY = 101_000_000_000n;
const USER_COLLATERAL = 10_000_000n;
const PLAY_USD = 1;
const OPEN_PRICE = 100_000_000;
const UP_SETTLE_PRICE = 100_050_000;
const DOWN_ENTRY_PRICE = 100_050_000;
const DOWN_SETTLE_PRICE = 100_000_000;
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const INITIALIZE_PRICE_FEED_DISCRIMINATOR = Buffer.from([68, 180, 81, 20, 102, 213, 145, 233]);
const UPDATE_PRICE_FEED_DISCRIMINATOR = Buffer.from([28, 9, 93, 150, 86, 153, 188, 115]);
const DELEGATE_PRICE_FEED_DISCRIMINATOR = Buffer.from([15, 179, 172, 145, 42, 73, 160, 241]);
const initializePriceFeedLayout = borsh.struct([
  borsh.str("provider"),
  borsh.str("symbol"),
  borsh.array(borsh.u8(), 32, "feedId"),
  borsh.i32("exponent"),
]);
const updatePriceFeedLayout = borsh.struct([
  borsh.str("provider"),
  borsh.struct([
    borsh.str("symbol"),
    borsh.array(borsh.u8(), 32, "id"),
    borsh.struct([borsh.u64("timestampNs"), borsh.i128("quantizedValue")], "temporalNumericValue"),
    borsh.array(borsh.u8(), 32, "publisherMerkleRoot"),
    borsh.array(borsh.u8(), 32, "valueComputeAlgHash"),
    borsh.array(borsh.u8(), 32, "r"),
    borsh.array(borsh.u8(), 32, "s"),
    borsh.u8("v"),
  ], "updateData"),
]);
const delegatePriceFeedLayout = borsh.struct([
  borsh.str("provider"),
  borsh.str("symbol"),
  borsh.array(borsh.u8(), 32, "validator"),
]);

function encodeInstruction(discriminator: Buffer, layout: borsh.Layout<unknown>, value: unknown): Buffer {
  const encoded = Buffer.alloc(1_000);
  const span = layout.encode(value, encoded);
  return Buffer.concat([discriminator, encoded.subarray(0, span)]);
}

function initializePriceFeedIx(payer: PublicKey) {
  return new anchor.web3.TransactionInstruction({
    programId: ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ORACLE_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInstruction(INITIALIZE_PRICE_FEED_DISCRIMINATOR, initializePriceFeedLayout, {
      provider: "pyth-lazer",
      symbol: "6",
      feedId: Array.from(ORACLE_FEED_ID),
      exponent: 8,
    }),
  });
}

function updatePriceFeedIx(payer: PublicKey, price: number, publishTime = Math.floor(Date.now() / 1_000)) {
  return new anchor.web3.TransactionInstruction({
    programId: ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ORACLE_ACCOUNT, isSigner: false, isWritable: true },
    ],
    data: encodeInstruction(UPDATE_PRICE_FEED_DISCRIMINATOR, updatePriceFeedLayout, {
      provider: "pyth-lazer",
      updateData: {
        symbol: "6",
        id: Array.from(ORACLE_ACCOUNT.toBytes()),
        temporalNumericValue: {
          timestampNs: new anchor.BN(publishTime).mul(new anchor.BN(1_000_000_000)),
          quantizedValue: new anchor.BN(price),
        },
        publisherMerkleRoot: Array(32).fill(0),
        valueComputeAlgHash: Array(32).fill(0),
        r: Array(32).fill(0),
        s: Array(32).fill(0),
        v: 0,
      },
    }),
  });
}

function delegatePriceFeedIx(payer: PublicKey, validator: PublicKey) {
  return new anchor.web3.TransactionInstruction({
    programId: ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ORACLE_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(ORACLE_ACCOUNT, ORACLE_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: delegationRecordPdaFromDelegatedAccount(ORACLE_ACCOUNT), isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPdaFromDelegatedAccount(ORACLE_ACCOUNT), isSigner: false, isWritable: true },
      { pubkey: ORACLE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInstruction(DELEGATE_PRICE_FEED_DISCRIMINATOR, delegatePriceFeedLayout, {
      provider: "pyth-lazer",
      symbol: "6",
      validator: Array.from(validator.toBytes()),
    }),
  });
}

async function sendTransaction(
  connection: Connection,
  transaction: Transaction,
  payer: Keypair,
  signers: Signer[] = [],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  const unique = new Map([payer, ...signers].map((signer) => [signer.publicKey.toBase58(), signer]));
  transaction.partialSign(...unique.values());
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (status.value?.err) throw new Error(`${signature}: ${JSON.stringify(status.value.err)}`);
    if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${signature}: confirmation timed out`);
}

async function eventually(label: string, predicate: () => Promise<boolean>, attempts = 120): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${String(lastError)}` : ""}`);
}

async function chainTimestamp(connection: Connection): Promise<number> {
  const clock = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!clock) throw new Error("Clock sysvar is missing");
  return Number(clock.data.readBigInt64LE(32));
}

async function validatorIdentity(): Promise<PublicKey> {
  const response = await fetch(ER_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
  });
  const body = await response.json() as { result?: { identity?: string }; error?: { message?: string } };
  if (!body.result?.identity) throw new Error(body.error?.message ?? "ER identity is missing");
  return new PublicKey(body.result.identity);
}

function userLiquidityAddress(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_liquidity"), user.toBuffer()],
    PROGRAM_ID,
  )[0];
}

async function positions(connection: Connection, address: PublicKey) {
  const account = await connection.getAccountInfo(address, "confirmed");
  return account ? decodeUserPositions(Buffer.from(account.data)) : [];
}

suite("local wallet-to-settlement flow", () => {
  const baseConnection = new Connection(BASE_RPC, "confirmed");
  const erConnection = new Connection(ER_RPC, { commitment: "confirmed", wsEndpoint: ER_WS });
  let publicConnection: Connection;
  let admin: Keypair;
  let program: anchor.Program;
  let erProgram: anchor.Program;
  let mint: PublicKey;
  let market: PublicKey;
  let userPositions: PublicKey;
  let userTokenAccount: PublicKey;
  let gameSession: StoredGameSession;
  const signatures: Record<string, string[]> = { base: [], er: [] };

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SOLANA_RPC_ENDPOINT = BASE_RPC;
    process.env.NEXT_PUBLIC_ROUTER_ENDPOINT = ROUTER_RPC;
    process.env.NEXT_PUBLIC_ER_STREAM_RPC_ENDPOINT = PUBLIC_RPC;
    process.env.NEXT_PUBLIC_ER_STREAM_WS_ENDPOINT = PUBLIC_WS;
    process.env.NEXT_PUBLIC_LEVERAGED_PREDICTION_PROGRAM_ID = PROGRAM_ID.toBase58();
    process.env.NEXT_PUBLIC_LEVERAGED_PREDICTION_MARKET_ID = String(MARKET_ID);
    process.env.SOLANA_RPC_ENDPOINT = BASE_RPC;
    process.env.ROUTER_ENDPOINT = ROUTER_RPC;
    process.env.LEVERAGED_PREDICTION_PROGRAM_ID = PROGRAM_ID.toBase58();
    process.env.LEVERAGED_PREDICTION_MARKET_ID = String(MARKET_ID);

    const localStorage = new Map<string, string>();
    const sessionStorage = new Map<string, string>();
    const storageApi = (storage: Map<string, string>) => ({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    Object.assign(globalThis, {
      window: {
        setTimeout,
        localStorage: storageApi(localStorage),
        sessionStorage: storageApi(sessionStorage),
      },
    });

    const secret = JSON.parse(await readFile(resolve(process.env.HOME!, ".config/solana/id.json"), "utf8")) as number[];
    admin = Keypair.fromSecretKey(Uint8Array.from(secret));
    const idl = JSON.parse(await readFile(resolve("target/idl/leveraged_prediction.json"), "utf8")) as anchor.Idl;
    const baseProvider = new anchor.AnchorProvider(baseConnection, new anchor.Wallet(admin), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const ephemeralProvider = new anchor.AnchorProvider(erConnection, new anchor.Wallet(admin), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    program = new anchor.Program(idl, baseProvider);
    erProgram = new anchor.Program(idl, ephemeralProvider);
    market = marketPda(PROGRAM_ID, MARKET_ID);
    userPositions = userPositionsPda(PROGRAM_ID, admin.publicKey);
  });

  it("connects a signer, routes collateral, plays both directions, streams price, and receives payouts", async () => {
    const validator = await validatorIdentity();
    mint = await createMint(baseConnection, admin, admin.publicKey, null, 6);
    userTokenAccount = await createAssociatedTokenAccount(baseConnection, admin, mint, admin.publicKey);
    await mintTo(baseConnection, admin, mint, userTokenAccount, admin, INITIAL_LIQUIDITY + USER_COLLATERAL);

    signatures.base.push(await sendTransaction(baseConnection, new Transaction().add(
      initializePriceFeedIx(admin.publicKey),
      updatePriceFeedIx(admin.publicKey, OPEN_PRICE),
    ), admin));
    signatures.base.push(await sendTransaction(baseConnection, new Transaction().add(
      delegatePriceFeedIx(admin.publicKey, validator),
    ), admin));

    const protocolConfig = protocolConfigPda(PROGRAM_ID);
    const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);
    signatures.base.push(await program.methods.initializeProtocolConfig().accountsPartial({
      admin: admin.publicKey,
      feeAuthority: admin.publicKey,
      program: PROGRAM_ID,
      programData,
      collateralMint: mint,
      protocolConfig,
      systemProgram: SystemProgram.programId,
    }).rpc());

    const feeAuthority = feeAuthorityPda(PROGRAM_ID, market);
    const poolTokenAccount = getAssociatedTokenAddressSync(mint, market, true);
    const feeTokenAccount = getAssociatedTokenAddressSync(mint, feeAuthority, true);
    signatures.base.push(await program.methods.initializeMarket(
      MARKET_ID,
      ORACLE_ACCOUNT,
      Array.from(ORACLE_FEED_ID),
      new anchor.BN(1_000_000),
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
    }).rpc());

    const userLiquidity = userLiquidityAddress(admin.publicKey);
    signatures.base.push(await program.methods.initializeUserLiquidity().accountsPartial({
      user: admin.publicKey,
      userLiquidity,
      systemProgram: SystemProgram.programId,
    }).rpc());
    signatures.base.push(await program.methods.delegateUserLiquidity(validator).accountsPartial({
      user: admin.publicKey,
      userLiquidity,
    }).rpc());

    const delegateUserTokens = await delegateSpl(admin.publicKey, mint, INITIAL_LIQUIDITY + USER_COLLATERAL, {
      payer: admin.publicKey,
      validator,
      idempotent: false,
      initVaultIfMissing: true,
    });
    signatures.base.push(await sendTransaction(baseConnection, new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...delegateUserTokens,
    ), admin));

    const [poolEata] = deriveEphemeralAta(market, mint);
    const [feeEata] = deriveEphemeralAta(feeAuthority, mint);
    signatures.base.push(await sendTransaction(baseConnection, new Transaction().add(
      initEphemeralAtaIx(poolEata, market, mint, admin.publicKey),
      delegateEphemeralAtaIx(admin.publicKey, poolEata, validator),
    ), admin));
    signatures.base.push(await sendTransaction(baseConnection, new Transaction().add(
      initEphemeralAtaIx(feeEata, feeAuthority, mint, admin.publicKey),
      delegateEphemeralAtaIx(admin.publicKey, feeEata, validator),
    ), admin));
    signatures.base.push(await program.methods.delegateMarket(MARKET_ID, validator).accountsPartial({
      payer: admin.publicKey,
      protocolConfig,
      market,
    }).rpc());

    for (const account of [
      market,
      userLiquidity,
      userTokenAccount,
      poolTokenAccount,
      feeTokenAccount,
      ORACLE_ACCOUNT,
    ]) {
      await eventually(`route ${account.toBase58()}`, async () => {
        const route = await getDelegationStatus(ROUTER_RPC, account.toBase58());
        return route.isDelegated && normalizeErEndpoint(route.fqdn ?? "") === `${ER_RPC}/`;
      });
    }
    await eventually("ER token mirrors", async () => {
      const accounts = await Promise.all([userTokenAccount, poolTokenAccount, feeTokenAccount].map(
        (account) => erConnection.getAccountInfo(account, "confirmed"),
      ));
      return accounts.every((account) => account?.owner.equals(TOKEN_PROGRAM_ID));
    });

    signatures.er.push(await erProgram.methods.depositLiquidity(
      new anchor.BN(INITIAL_LIQUIDITY.toString()),
      new anchor.BN(0),
    ).accountsPartial({
      user: admin.publicKey,
      protocolConfig,
      market,
      userLiquidity,
      poolTokenAccount,
      userTokenAccount,
      collateralMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc());

    let walletSignCount = 0;
    const walletSign = async <T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> => {
      walletSignCount += 1;
      if (transaction instanceof Transaction) {
        transaction.partialSign(admin);
      } else {
        transaction.sign([admin]);
      }
      return transaction;
    };
    const signMessage = async (message: Uint8Array) => nacl.sign.detached(message, admin.secretKey);
    const { authorizeErAccess } = await import("@/app/lib/live/er-access");
    const publicAccess = await authorizeErAccess(PUBLIC_RPC, PUBLIC_WS, admin.publicKey, signMessage);
    publicConnection = new Connection(publicAccess.rpcEndpoint, {
      commitment: "confirmed",
      wsEndpoint: publicAccess.wsEndpoint,
    });
    const sessionProgress: SessionProgress[] = [];
    const availableSessions: StoredGameSession[] = [];
    gameSession = await createGameSessionFlow(
      admin.publicKey,
      2,
      walletSign,
      (update) => sessionProgress.push(update),
      {
        onSessionAvailable: (available) => availableSessions.push(available),
      },
    );
    expect(availableSessions.map((session) => session.setupComplete)).toEqual([false, true]);

    const resumedProgress: SessionProgress[] = [];
    const originalSessionToken = gameSession.sessionToken;
    gameSession = await createGameSessionFlow(
      admin.publicKey,
      2,
      walletSign,
      (update) => resumedProgress.push(update),
      { existingSession: gameSession },
    );
    expect(gameSession.sessionToken).toBe(originalSessionToken);
    expect(resumedProgress.some((update) => update.phase === "creating")).toBe(false);
    expect(resumedProgress).toHaveLength(1);
    expect(resumedProgress.at(-1)?.phase).toBe("ready");
    const walletSignCountBeforePlay = walletSignCount;
    expect(walletSignCountBeforePlay).toBe(2);
    const sessionSignerInfo = await baseConnection.getAccountInfo(
      sessionKeypair(gameSession).publicKey,
      "confirmed",
    );
    expect(sessionSignerInfo?.owner.equals(DELEGATION_PROGRAM_ID) ?? false).toBe(false);
    const progress: TransactionProgress[] = [];
    const play = async (direction: "up" | "down", entryPrice: number, settlementPrice: number) => {
      signatures.er.push(await sendTransaction(erConnection, new Transaction().add(
        updatePriceFeedIx(admin.publicKey, entryPrice),
      ), admin));
      const beforeBalance = (await getAccount(erConnection, userTokenAccount, "confirmed")).amount;
      let keepOracleFresh = true;
      let oracleRefreshError: unknown;
      const refreshOracle = (async () => {
        while (keepOracleFresh) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
          if (!keepOracleFresh) break;
          try {
            await sendTransaction(erConnection, new Transaction().add(
              updatePriceFeedIx(admin.publicKey, entryPrice),
            ), admin);
          } catch (error) {
            oracleRefreshError = error;
            break;
          }
        }
      })();
      let result: Awaited<ReturnType<typeof openPositionFlow>>;
      try {
        const quote = await readLiveSnapshot(admin.publicKey.toBase58());
        const prepared = await prepareOpenPosition(
          admin.publicKey,
          gameSession,
          quote,
        );
        result = await openPositionFlow(
          admin.publicKey,
          direction,
          PLAY_USD,
          gameSession,
          prepared,
          {
            rawPrice: quote.currentRawPrice!,
            nextPositionNonce: quote.nextPositionNonce!,
          },
          (update) => progress.push(update),
        );
      } finally {
        keepOracleFresh = false;
        await refreshOracle;
      }
      if (oracleRefreshError) throw oracleRefreshError;
      if (!result.accepted) {
        console.error(JSON.stringify({
          intent: result.intent,
          signatureStatus: result.intent.erSignature
            ? await erConnection.getSignatureStatus(result.intent.erSignature, { searchTransactionHistory: true })
            : null,
          positions: await positions(erConnection, userPositions),
        }, null, 2));
      }
      expect(result.accepted, result.intent.message).toBe(true);
      expect(walletSignCount).toBe(walletSignCountBeforePlay);
      expect(result.intent.erSignature).toBeTruthy();
      signatures.er.push(result.intent.erSignature!);
      await eventually(
        "submitted position visibility",
        async () => (await positions(erConnection, userPositions)).length === 1,
      );
      const opened = await positions(erConnection, userPositions);
      expect(opened).toHaveLength(1);
      expect(opened[0].direction).toBe(direction);
      const activeSnapshot = await readLiveSnapshot(admin.publicKey.toBase58());
      expect(activeSnapshot.plays).toHaveLength(1);
      expect(activeSnapshot.walletAddress).toBe(admin.publicKey.toBase58());

      await eventually("position expiry", async () => (await chainTimestamp(erConnection)) >= opened[0].expiresAt);
      let markStreamReady!: () => void;
      const streamReady = new Promise<void>((resolveReady) => {
        markStreamReady = resolveReady;
      });
      const streamedPrice = new Promise<bigint>((resolvePrice, rejectPrice) => {
        const stop = subscribeOraclePrice({
          erEndpoint: PUBLIC_RPC,
          oracleAddress: ORACLE_ACCOUNT.toBase58(),
          oracleFeedId: ORACLE_FEED_ID.toString("hex"),
        }, (update) => {
          markStreamReady();
          if (update.rawPrice === BigInt(settlementPrice)) {
            stop();
            resolvePrice(update.rawPrice);
          }
        }, (error) => {
          if (error instanceof Error && /stale or invalid/.test(error.message)) {
            markStreamReady();
          } else {
            rejectPrice(error);
          }
        }, publicConnection);
      });
      await streamReady;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      signatures.er.push(await sendTransaction(erConnection, new Transaction().add(
        updatePriceFeedIx(admin.publicKey, settlementPrice, await chainTimestamp(erConnection)),
      ), admin));
      let observedPrice: bigint;
      try {
        observedPrice = await Promise.race([
          streamedPrice,
          new Promise<never>((_, rejectTimeout) => setTimeout(
            () => rejectTimeout(new Error("oracle websocket did not deliver the settlement update")),
            5_000,
          )),
        ]);
      } catch (error) {
        const oracle = await erConnection.getAccountInfo(ORACLE_ACCOUNT, "confirmed");
        throw new Error(`${String(error)}; oracle=${JSON.stringify(oracle ? {
          rawPrice: oracle.data.readBigInt64LE(73).toString(),
          publishTime: oracle.data.readBigInt64LE(93).toString(),
          postedSlot: oracle.data.readBigUInt64LE(125).toString(),
          wallTime: Math.floor(Date.now() / 1_000),
          chainTime: await chainTimestamp(erConnection),
        } : null)}`);
      }
      expect(observedPrice).toBe(BigInt(settlementPrice));
      await eventually(
        "automatic scheduler settlement",
        async () => (await positions(erConnection, userPositions)).length === 0,
        160,
      );
      const afterBalance = (await getAccount(erConnection, userTokenAccount, "confirmed")).amount;
      expect(afterBalance).toBeGreaterThan(beforeBalance);
      clearOpenIntent(admin.publicKey.toBase58(), MARKET_ID);
    };

    await play("up", OPEN_PRICE, UP_SETTLE_PRICE);
    await play("down", DOWN_ENTRY_PRICE, DOWN_SETTLE_PRICE);

    const finalSnapshot = await readLiveSnapshot(admin.publicKey.toBase58());
    expect(finalSnapshot.plays).toHaveLength(0);
    expect(finalSnapshot.walletBalanceUsd).toBeGreaterThan(Number(USER_COLLATERAL) / 1_000_000 - 1);
    expect(sessionProgress.some((update) => update.phase === "creating")).toBe(true);
    expect(sessionProgress.some((update) => update.phase === "preparing-accounts")).toBe(true);
    expect(sessionProgress.some((update) => update.phase === "approving")).toBe(true);
    expect(sessionProgress.at(-1)?.phase).toBe("ready");
    expect(progress.filter((update) => update.phase === "confirming")).toHaveLength(2);

    console.log(JSON.stringify({
      wallet: admin.publicKey.toBase58(),
      mint: mint.toBase58(),
      market: market.toBase58(),
      baseSignatures: signatures.base,
      erSignatures: signatures.er,
      sessionPhases: sessionProgress.map((update) => update.phase),
      phases: progress.map((update) => update.phase),
      finalBalanceUsd: finalSnapshot.walletBalanceUsd,
      scheduler: "magicblock-native",
    }, null, 2));
  }, 180_000);
});
