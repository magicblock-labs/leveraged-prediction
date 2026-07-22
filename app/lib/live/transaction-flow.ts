import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  createDelegateInstruction,
  decodeEphemeralAta,
  delegateEphemeralAtaIx,
  depositSplTokensIx,
  deriveEphemeralAta,
  deriveShuttleAta,
  deriveShuttleEphemeralAta,
  deriveShuttleWalletAta,
  deriveVault,
  deriveVaultAta,
  initEphemeralAtaIx,
  setupAndDelegateShuttleEphemeralAtaWithMergeIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Direction } from "@/app/lib/domain";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import {
  decodeMarket,
  decodeProtocolConfig,
  decodeUserPositions,
} from "@/app/lib/live/decode";
import {
  claimFallbackPayoutInstruction,
  deriveHydraCrank,
  delegateUserPositionsInstruction,
  initializeUserPositionsInstruction,
  openPositionInstruction,
} from "@/app/lib/live/instructions";
import {
  clearOpenIntent,
  createOpenIntent,
  hexToBytes,
  loadOpenIntent,
  requiresIntentRecovery,
  saveOpenIntent,
  type OpenPositionIntent,
} from "@/app/lib/live/intent-store";
import {
  feeAuthorityPda,
  marketPda,
  protocolConfigPda,
  userPositionsPda,
} from "@/app/lib/live/pdas";
import { decodeOraclePrice } from "@/app/lib/live/oracle";
import {
  getDelegationStatus,
  normalizeErEndpoint,
} from "@/app/lib/live/router";
import { ORACLE_PROGRAM_ID } from "@/app/lib/live/config";
import { Buffer } from "buffer";

const MAX_POSITION_MINOR = 1_000_000_000n;
const ROUTE_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 20_000;
const ER_FEE_PAYER_LAMPORTS = 10_000_000;
const feePayerSessions = new Map<string, Keypair>();

export type TransactionPhase =
  | "checking"
  | "initializing-positions"
  | "provisioning-payout"
  | "depositing-collateral"
  | "preparing-fee-payer"
  | "verifying-route"
  | "submitting"
  | "confirming"
  | "accepted"
  | "recovering";

export interface TransactionProgress {
  phase: TransactionPhase;
  message: string;
  intent: OpenPositionIntent;
}

export async function claimFallbackPayoutFlow(
  user: PublicKey,
  sendTransaction: SendTransaction,
  onStatus: (message: string) => void,
): Promise<string | null> {
  onStatus("Checking the protected payout balance…");
  const context = await loadWriteContext(user);
  const userTokenAccount = getAssociatedTokenAddressSync(context.collateralMint, context.user);
  const payoutEscrowTokenAccount = getAssociatedTokenAddressSync(
    context.collateralMint,
    context.userPositions,
    true,
  );
  await assertRouteSet(context, [
    context.userPositions,
    userTokenAccount,
    payoutEscrowTokenAccount,
  ]);
  const payout = await getAccount(context.erConnection, payoutEscrowTokenAccount, "confirmed");
  if (payout.amount === 0n) return null;
  const feePayer = await ensureErFeePayer(context, sendTransaction, onStatus);
  onStatus(`Claiming ${Number(payout.amount) / 1_000_000} USDC…`);

  const instruction = claimFallbackPayoutInstruction(context.programId, {
    user: context.user,
    protocolConfig: context.protocolConfig,
    userPositions: context.userPositions,
    payoutEscrowTokenAccount,
    userTokenAccount,
    collateralMint: context.collateralMint,
  });
  let submittedSignature: string | null = null;
  try {
    return await sendAndConfirm(
      context.erConnection,
      context.user,
      sendTransaction,
      [instruction],
      (signature) => {
        submittedSignature = signature;
        onStatus("Claim sent. Confirming your balance…");
      },
      { feePayer: feePayer.publicKey, additionalSigners: [feePayer] },
    );
  } catch (cause) {
    await sleep(300);
    const remaining = await getAccount(
      context.erConnection,
      payoutEscrowTokenAccount,
      "confirmed",
    ).catch(() => null);
    if (remaining?.amount === 0n) return submittedSignature;
    throw cause;
  }
}

export interface OpenFlowResult {
  intent: OpenPositionIntent;
  accepted: boolean;
}

interface LiveWriteContext {
  baseConnection: Connection;
  erConnection: Connection;
  routerEndpoint: string;
  erEndpoint: string;
  validator: PublicKey;
  programId: PublicKey;
  marketId: number;
  market: PublicKey;
  user: PublicKey;
  userPositions: PublicKey;
  protocolConfig: PublicKey;
  collateralMint: PublicKey;
  feeAuthority: PublicKey;
  oracle: PublicKey;
}

type SendTransaction = WalletContextState["sendTransaction"];
type ProgressHandler = (progress: TransactionProgress) => void;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function randomU32(): number {
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return bytes[0];
}

function randomTaskSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  do globalThis.crypto.getRandomValues(salt);
  while (salt.every((value) => value === 0));
  return salt;
}

async function rpcIdentity(endpoint: string): Promise<PublicKey> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "validator-identity", method: "getIdentity", params: [] }),
  });
  const body = (await response.json()) as {
    result?: { identity?: string };
    error?: { message?: string };
  };
  if (!response.ok || body.error || !body.result?.identity) {
    throw new Error(body.error?.message ?? "The routed ER did not return its validator identity");
  }
  return new PublicKey(body.result.identity);
}

async function sendAndConfirm(
  connection: Connection,
  user: PublicKey,
  sendTransaction: SendTransaction,
  instructions: TransactionInstruction[],
  onSubmitted?: (signature: string) => void,
  options?: { feePayer?: PublicKey; additionalSigners?: Signer[] },
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: options?.feePayer ?? user,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  const signature = await sendTransaction(transaction, connection, {
    preflightCommitment: "confirmed",
    skipPreflight: false,
    maxRetries: 3,
    signers: options?.additionalSigners,
  });
  onSubmitted?.(signature);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.err) {
      throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.value.err)}`);
    }
    if (
      status.value?.confirmationStatus === "confirmed" ||
      status.value?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    await sleep(200);
  }
  throw new Error(`Transaction ${signature} was not confirmed within 15 seconds`);
}

async function ensureErFeePayer(
  context: LiveWriteContext,
  sendTransaction: SendTransaction,
  onStatus: (message: string) => void,
  onSubmitted?: (signature: string) => void,
): Promise<Keypair> {
  const key = `${context.user.toBase58()}:${context.validator.toBase58()}`;
  const existing = feePayerSessions.get(key);
  if (existing) {
    const info = await context.baseConnection.getAccountInfo(existing.publicKey, "confirmed");
    if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
      await waitForRoute(context.routerEndpoint, existing.publicKey, context.erEndpoint);
      return existing;
    }
    feePayerSessions.delete(key);
  }

  onStatus("Preparing a fast fee account for this arena…");
  const feePayer = Keypair.generate();
  await sendAndConfirm(
    context.baseConnection,
    context.user,
    sendTransaction,
    [
      SystemProgram.transfer({
        fromPubkey: context.user,
        toPubkey: feePayer.publicKey,
        lamports: ER_FEE_PAYER_LAMPORTS,
      }),
      SystemProgram.assign({
        accountPubkey: feePayer.publicKey,
        programId: DELEGATION_PROGRAM_ID,
      }),
      createDelegateInstruction(
        {
          payer: context.user,
          delegatedAccount: feePayer.publicKey,
          ownerProgram: SystemProgram.programId,
          validator: context.validator,
        },
        { validator: context.validator },
      ),
    ],
    onSubmitted,
    { additionalSigners: [feePayer] },
  );
  await waitForRoute(context.routerEndpoint, feePayer.publicKey, context.erEndpoint);
  feePayerSessions.set(key, feePayer);
  return feePayer;
}

async function waitForRoute(
  routerEndpoint: string,
  account: PublicKey,
  expectedEndpoint: string,
): Promise<void> {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  let lastError = "delegation has not reached the router";
  while (Date.now() < deadline) {
    try {
      const route = await getDelegationStatus(routerEndpoint, account.toBase58());
      if (route.isDelegated && route.fqdn) {
        const actual = normalizeErEndpoint(route.fqdn);
        if (actual !== expectedEndpoint) {
          throw new Error(`${account.toBase58()} is routed to ${actual}, expected ${expectedEndpoint}`);
        }
        return;
      }
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : lastError;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${account.toBase58()}: ${lastError}`);
}

async function waitForTokenAmount(
  connection: Connection,
  tokenAccount: PublicKey,
  minimumAmount: bigint,
): Promise<void> {
  const deadline = Date.now() + TOKEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const account = await getAccount(connection, tokenAccount, "confirmed").catch(() => null);
    if (account && account.amount >= minimumAmount) return;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ER token balance at ${tokenAccount.toBase58()}`);
}

async function loadWriteContext(user: PublicKey): Promise<LiveWriteContext> {
  const config = readClientLiveConfig();
  const baseConnection = new Connection(config.baseRpcEndpoint, "confirmed");
  const market = marketPda(config.programId, config.marketId);
  const baseMarket = await baseConnection.getAccountInfo(market, "confirmed");
  if (!baseMarket || !baseMarket.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("The configured Market is not delegated on the base layer");
  }
  const marketRoute = await getDelegationStatus(config.routerEndpoint, market.toBase58());
  if (!marketRoute.isDelegated || !marketRoute.fqdn) {
    throw new Error("The router has no active Market route");
  }
  const erEndpoint = normalizeErEndpoint(marketRoute.fqdn);
  const erConnection = new Connection(erEndpoint, "confirmed");
  const marketInfo = await erConnection.getAccountInfo(market, "confirmed");
  if (!marketInfo || !marketInfo.owner.equals(config.programId)) {
    throw new Error("The Market is missing from its routed ER");
  }
  const decodedMarket = decodeMarket(Buffer.from(marketInfo.data));
  if (decodedMarket.marketId !== config.marketId) throw new Error("Routed Market ID mismatch");

  const protocolConfig = protocolConfigPda(config.programId);
  const protocolInfo = await baseConnection.getAccountInfo(protocolConfig, "confirmed");
  if (!protocolInfo || !protocolInfo.owner.equals(config.programId)) {
    throw new Error("ProtocolConfig is missing or has the wrong owner");
  }
  const decodedProtocol = decodeProtocolConfig(Buffer.from(protocolInfo.data));
  const collateralMint = new PublicKey(decodedProtocol.collateralMint);

  return {
    baseConnection,
    erConnection,
    routerEndpoint: config.routerEndpoint,
    erEndpoint,
    validator: await rpcIdentity(erEndpoint),
    programId: config.programId,
    marketId: config.marketId,
    market,
    user,
    userPositions: userPositionsPda(config.programId, user),
    protocolConfig,
    collateralMint,
    feeAuthority: feeAuthorityPda(config.programId, market),
    oracle: new PublicKey(decodedMarket.oracle),
  };
}

function updateIntent(
  intent: OpenPositionIntent,
  changes: Partial<OpenPositionIntent>,
): OpenPositionIntent {
  return saveOpenIntent({ ...intent, ...changes });
}

function report(
  onProgress: ProgressHandler,
  intent: OpenPositionIntent,
  phase: TransactionPhase,
  message: string,
): void {
  onProgress({ phase, message, intent });
}

async function ensureUserPositions(
  context: LiveWriteContext,
  sendTransaction: SendTransaction,
  intent: OpenPositionIntent,
  onProgress: ProgressHandler,
): Promise<OpenPositionIntent> {
  const info = await context.baseConnection.getAccountInfo(context.userPositions, "confirmed");
  if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
    await waitForRoute(context.routerEndpoint, context.userPositions, context.erEndpoint);
    return intent;
  }
  if (info && !info.owner.equals(context.programId)) {
    throw new Error("UserPositions has an unexpected base-layer owner");
  }
  report(onProgress, intent, "initializing-positions", info ? "Routing your play slots to the arena…" : "Creating your play slots…");
  const instructions = info
    ? [delegateUserPositionsInstruction(context.programId, context.user, context.userPositions, context.validator)]
    : [
        initializeUserPositionsInstruction(context.programId, context.user, context.userPositions),
        delegateUserPositionsInstruction(context.programId, context.user, context.userPositions, context.validator),
      ];
  await sendAndConfirm(
    context.baseConnection,
    context.user,
    sendTransaction,
    instructions,
    (signature) => {
      intent = updateIntent(intent, {
        status: "onboarding",
        baseSignatures: [...intent.baseSignatures, signature],
      });
    },
  );
  await waitForRoute(context.routerEndpoint, context.userPositions, context.erEndpoint);
  return intent;
}

async function ensureFallbackBalance(
  context: LiveWriteContext,
  sendTransaction: SendTransaction,
  intent: OpenPositionIntent,
  onProgress: ProgressHandler,
): Promise<{ intent: OpenPositionIntent; eata: PublicKey; ata: PublicKey }> {
  const [eata] = deriveEphemeralAta(context.userPositions, context.collateralMint);
  const ata = getAssociatedTokenAddressSync(
    context.collateralMint,
    context.userPositions,
    true,
  );
  const [info, ataInfo] = await context.baseConnection.getMultipleAccountsInfo(
    [eata, ata],
    "confirmed",
  );
  const instructions: TransactionInstruction[] = [];
  if (!ataInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        context.user,
        ata,
        context.userPositions,
        context.collateralMint,
      ),
    );
  }
  if (!info || info.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)) {
    report(onProgress, intent, "provisioning-payout", "Preparing your protected payout account…");
    if (!info) {
      instructions.push(
        initEphemeralAtaIx(eata, context.userPositions, context.collateralMint, context.user),
      );
    } else {
      const decoded = decodeEphemeralAta(info);
      if (!decoded.owner.equals(context.userPositions) || !decoded.mint.equals(context.collateralMint)) {
        throw new Error("Fallback eSPL balance owner or mint mismatch");
      }
    }
    instructions.push(delegateEphemeralAtaIx(context.user, eata, context.validator));
  } else if (!info.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("Fallback eSPL balance has an unexpected owner");
  }
  if (instructions.length > 0) {
    await sendAndConfirm(
      context.baseConnection,
      context.user,
      sendTransaction,
      instructions,
      (signature) => {
        intent = updateIntent(intent, {
          status: "onboarding",
          baseSignatures: [...intent.baseSignatures, signature],
        });
      },
    );
  }
  await waitForRoute(context.routerEndpoint, ata, context.erEndpoint);
  await waitForTokenAmount(context.erConnection, ata, 0n);
  const account = await getAccount(context.erConnection, ata, "confirmed");
  if (!account.owner.equals(context.userPositions) || !account.mint.equals(context.collateralMint)) {
    throw new Error("Fallback payout ATA owner or mint mismatch on the ER");
  }
  return { intent, eata, ata };
}

async function ensureCollateralBalance(
  context: LiveWriteContext,
  amount: bigint,
  sendTransaction: SendTransaction,
  intent: OpenPositionIntent,
  onProgress: ProgressHandler,
): Promise<{ intent: OpenPositionIntent; eata: PublicKey; ata: PublicKey }> {
  const [eata] = deriveEphemeralAta(context.user, context.collateralMint);
  const ata = getAssociatedTokenAddressSync(context.collateralMint, context.user);
  const routed = await getDelegationStatus(context.routerEndpoint, ata.toBase58()).catch(() => null);
  const isDelegated = Boolean(routed?.isDelegated && routed.fqdn);
  let erAmount = 0n;
  if (isDelegated) {
    const actualEndpoint = normalizeErEndpoint(routed!.fqdn!);
    if (actualEndpoint !== context.erEndpoint) {
      throw new Error(`Your collateral is routed to ${actualEndpoint}, not the Market ER`);
    }
    erAmount = (await getAccount(context.erConnection, ata, "confirmed").catch(() => null))?.amount ?? 0n;
  }
  if (erAmount >= amount) return { intent, eata, ata };

  const shortfall = amount - erAmount;
  const baseToken = await getAccount(context.baseConnection, ata, "confirmed").catch(() => null);
  if (!baseToken || baseToken.amount < shortfall) {
    const available = baseToken?.amount ?? 0n;
    throw new Error(
      `Base wallet needs at least ${Number(shortfall) / 1_000_000} USDC; available ${Number(available) / 1_000_000}`,
    );
  }
  report(onProgress, intent, "depositing-collateral", `Moving ${Number(shortfall) / 1_000_000} USDC into the arena…`);

  let instructions: TransactionInstruction[];
  if (isDelegated) {
    const shuttleId = randomU32();
    const [shuttleEata] = deriveShuttleEphemeralAta(context.user, context.collateralMint, shuttleId);
    const [shuttleAta] = deriveShuttleAta(shuttleEata, context.collateralMint);
    const shuttleWalletAta = deriveShuttleWalletAta(context.collateralMint, shuttleEata);
    instructions = [
      setupAndDelegateShuttleEphemeralAtaWithMergeIx(
        context.user,
        shuttleEata,
        shuttleAta,
        context.user,
        ata,
        ata,
        shuttleWalletAta,
        context.collateralMint,
        shuttleId,
        shortfall,
        context.validator,
      ),
    ];
  } else {
    const info = await context.baseConnection.getAccountInfo(eata, "confirmed");
    const [vault] = deriveVault(context.collateralMint);
    const vaultAta = deriveVaultAta(context.collateralMint, vault);
    const [vaultInfo, vaultAtaInfo] = await context.baseConnection.getMultipleAccountsInfo(
      [vault, vaultAta],
      "confirmed",
    );
    if (!vaultInfo || !vaultAtaInfo) {
      throw new Error("The configured collateral eSPL vault is not initialized");
    }
    instructions = [];
    if (!info) {
      instructions.push(initEphemeralAtaIx(eata, context.user, context.collateralMint, context.user));
    } else {
      if (!info.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)) {
        throw new Error("User collateral eSPL balance has an unexpected owner");
      }
      const decoded = decodeEphemeralAta(info);
      if (!decoded.owner.equals(context.user) || !decoded.mint.equals(context.collateralMint)) {
        throw new Error("User collateral eSPL owner or mint mismatch");
      }
    }
    instructions.push(
      depositSplTokensIx(eata, vault, context.collateralMint, ata, vaultAta, context.user, shortfall),
      delegateEphemeralAtaIx(context.user, eata, context.validator),
    );
  }

  await sendAndConfirm(
    context.baseConnection,
    context.user,
    sendTransaction,
    instructions,
    (signature) => {
      intent = updateIntent(intent, {
        status: "onboarding",
        baseSignatures: [...intent.baseSignatures, signature],
      });
    },
  );
  await waitForRoute(context.routerEndpoint, ata, context.erEndpoint);
  await waitForTokenAmount(context.erConnection, ata, amount);
  return { intent, eata, ata };
}

async function assertRouteSet(
  context: LiveWriteContext,
  accounts: PublicKey[],
): Promise<void> {
  await Promise.all(
    accounts.map((account) =>
      waitForRoute(context.routerEndpoint, account, context.erEndpoint),
    ),
  );
}

async function positionMatchesIntent(
  context: LiveWriteContext,
  intent: OpenPositionIntent,
): Promise<boolean> {
  if (intent.nonce === undefined) return false;
  const info = await context.erConnection.getAccountInfo(context.userPositions, "confirmed");
  if (!info || !info.owner.equals(context.programId)) return false;
  const salt = hexToBytes(intent.taskSaltHex);
  return decodeUserPositions(Buffer.from(info.data)).some(
    (position) =>
      position.marketId === intent.marketId &&
      position.nonce === intent.nonce &&
      sameBytes(position.taskSalt, salt),
  );
}

async function waitForPositionMatch(
  context: LiveWriteContext,
  intent: OpenPositionIntent,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await positionMatchesIntent(context, intent)) return true;
    await sleep(200);
  }
  return false;
}

export async function recoverOpenPositionIntent(
  user: PublicKey,
  intent: OpenPositionIntent,
): Promise<OpenFlowResult> {
  const context = await loadWriteContext(user);
  if (await positionMatchesIntent(context, intent)) {
    return { intent: updateIntent(intent, { status: "accepted", message: "Play accepted" }), accepted: true };
  }
  if (intent.erSignature) {
    const status = await context.erConnection.getSignatureStatus(intent.erSignature, {
      searchTransactionHistory: true,
    });
    if (status.value?.err) {
      return {
        intent: updateIntent(intent, {
          status: "failed",
          message: `ER transaction failed: ${JSON.stringify(status.value.err)}`,
        }),
        accepted: false,
      };
    }
  }
  if (intent.nonce === undefined && intent.baseSignatures.length > 0) {
    const statuses = await context.baseConnection.getSignatureStatuses(
      intent.baseSignatures,
      { searchTransactionHistory: true },
    );
    const failed = statuses.value.find((status) => status?.err);
    if (failed?.err) {
      return {
        intent: updateIntent(intent, {
          status: "failed",
          message: `Setup transaction failed: ${JSON.stringify(failed.err)}`,
        }),
        accepted: false,
      };
    }
    if (statuses.value.every((status) => status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized")) {
      return {
        intent: updateIntent(intent, {
          status: "failed",
          message: "Account setup confirmed. Press play again to continue safely.",
        }),
        accepted: false,
      };
    }
  }
  return {
    intent: updateIntent(intent, {
      status: "ambiguous",
      message: "The ER result is still unknown. Check status before trying again.",
    }),
    accepted: false,
  };
}

export async function openPositionFlow(
  user: PublicKey,
  direction: Direction,
  amountUsd: number,
  sendTransaction: SendTransaction,
  onProgress: ProgressHandler,
): Promise<OpenFlowResult> {
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1_000) {
    throw new Error("Play amount must be between 1 and 1,000 USDC");
  }
  const collateral = BigInt(Math.round(amountUsd * 1_000_000));
  if (collateral > MAX_POSITION_MINOR) throw new Error("Play amount exceeds the contract maximum");
  const config = readClientLiveConfig();
  const existing = loadOpenIntent(user.toBase58(), config.marketId);
  if (existing && requiresIntentRecovery(existing)) {
    report(onProgress, existing, "recovering", "Checking the previous play before sending anything…");
    const recovered = await recoverOpenPositionIntent(user, existing);
    if (recovered.accepted || recovered.intent.status === "ambiguous") return recovered;
    clearOpenIntent(user.toBase58(), config.marketId);
  }

  let intent = createOpenIntent(
    user.toBase58(),
    config.marketId,
    direction,
    collateral,
    randomTaskSalt(),
  );
  intent = saveOpenIntent(intent);
  report(onProgress, intent, "checking", "Checking the arena and your account setup…");
  const context = await loadWriteContext(user);
  if (context.marketId !== intent.marketId) throw new Error("Intent Market ID changed during setup");

  try {
    intent = await ensureUserPositions(context, sendTransaction, intent, onProgress);
    const fallback = await ensureFallbackBalance(context, sendTransaction, intent, onProgress);
    intent = fallback.intent;
    const collateralBalance = await ensureCollateralBalance(
      context,
      collateral,
      sendTransaction,
      intent,
      onProgress,
    );
    intent = collateralBalance.intent;
    report(onProgress, intent, "preparing-fee-payer", "Preparing a fast fee account for this arena…");
    const feePayer = await ensureErFeePayer(
      context,
      sendTransaction,
      () => undefined,
      (signature) => {
        intent = updateIntent(intent, {
          status: "onboarding",
          baseSignatures: [...intent.baseSignatures, signature],
        });
      },
    );

    report(onProgress, intent, "verifying-route", "Verifying every play account is in the same arena…");
    const poolTokenAccount = getAssociatedTokenAddressSync(context.collateralMint, context.market, true);
    const feeTokenAccount = getAssociatedTokenAddressSync(context.collateralMint, context.feeAuthority, true);
    await assertRouteSet(context, [
      context.market,
      context.userPositions,
      collateralBalance.ata,
      fallback.ata,
      poolTokenAccount,
      feeTokenAccount,
      context.oracle,
    ]);

    const marketInfo = await context.erConnection.getAccountInfo(context.market, "confirmed");
    if (!marketInfo || !marketInfo.owner.equals(context.programId)) throw new Error("Market disappeared from the ER");
    const market = decodeMarket(Buffer.from(marketInfo.data));
    if (market.mode !== "open") throw new Error("The Market is close-only");
    if (market.activePositions >= 8) throw new Error("The Market is at its eight-position risk limit");
    const positionsInfo = await context.erConnection.getAccountInfo(context.userPositions, "confirmed");
    if (!positionsInfo || decodeUserPositions(Buffer.from(positionsInfo.data)).length >= 8) {
      throw new Error("Your eight play slots are full");
    }
    const oracleInfo = await context.erConnection.getAccountInfo(context.oracle, "confirmed");
    if (!oracleInfo || !oracleInfo.owner.equals(ORACLE_PROGRAM_ID)) {
      throw new Error("The configured oracle is unavailable on the ER");
    }
    const price = decodeOraclePrice(
      Buffer.from(oracleInfo.data),
      market.oracleFeedId,
      Math.floor(Date.now() / 1_000),
    );

    const [pool, fee, userToken, payout] = await Promise.all([
      getAccount(context.erConnection, poolTokenAccount, "confirmed"),
      getAccount(context.erConnection, feeTokenAccount, "confirmed"),
      getAccount(context.erConnection, collateralBalance.ata, "confirmed"),
      getAccount(context.erConnection, fallback.ata, "confirmed"),
    ]);
    const expectedOwners = [context.market, context.feeAuthority, context.user, context.userPositions];
    for (const [index, token] of [pool, fee, userToken, payout].entries()) {
      if (!token.mint.equals(context.collateralMint) || !token.owner.equals(expectedOwners[index])) {
        throw new Error("An ER token account failed its canonical mint/owner check");
      }
    }

    const taskSalt = hexToBytes(intent.taskSaltHex);
    const hydraCrank = await deriveHydraCrank(context.market, context.user, market.nextPositionNonce, taskSalt);
    const slippage = price.rawPrice / 2_000n > 0n ? price.rawPrice / 2_000n : 1n;
    intent = updateIntent(intent, {
      status: "ready",
      nonce: market.nextPositionNonce,
      erEndpoint: context.erEndpoint,
    });
    const instruction = openPositionInstruction(
      context.programId,
      {
        user: context.user,
        taskPayer: feePayer.publicKey,
        protocolConfig: context.protocolConfig,
        market: context.market,
        userPositions: context.userPositions,
        poolTokenAccount,
        derivedFeeAuthority: context.feeAuthority,
        feeTokenAccount,
        userTokenAccount: collateralBalance.ata,
        payoutEscrowTokenAccount: fallback.ata,
        collateralMint: context.collateralMint,
        priceUpdate: context.oracle,
        hydraCrank,
      },
      {
        nonce: market.nextPositionNonce,
        taskSalt,
        direction,
        collateral,
        minEntryPrice: price.rawPrice - slippage,
        maxEntryPrice: price.rawPrice + slippage,
      },
    );

    intent = updateIntent(intent, { status: "submitting", message: "Waiting for wallet signature" });
    report(onProgress, intent, "submitting", `Approve this Play ${direction === "up" ? "Up" : "Down"} transaction in your wallet…`);
    let signature: string;
    try {
      signature = await sendAndConfirm(
        context.erConnection,
        context.user,
        sendTransaction,
        [instruction],
        (submittedSignature) => {
          intent = updateIntent(intent, {
            status: "confirming",
            erSignature: submittedSignature,
          });
          report(onProgress, intent, "confirming", "Play sent. Confirming it in Your Plays…");
        },
        { feePayer: feePayer.publicKey, additionalSigners: [feePayer] },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ER submission result is unknown";
      if (!intent.erSignature) {
        intent = updateIntent(intent, { status: "failed", message });
        throw cause;
      }
      intent = updateIntent(intent, {
        status: "ambiguous",
        message,
      });
      return recoverOpenPositionIntent(user, intent);
    }
    if (intent.erSignature !== signature) {
      intent = updateIntent(intent, { status: "confirming", erSignature: signature });
    }
    if (!(await waitForPositionMatch(context, intent))) {
      intent = updateIntent(intent, {
        status: "ambiguous",
        message: "The signature confirmed but the position is not visible yet",
      });
      return { intent, accepted: false };
    }
    intent = updateIntent(intent, { status: "accepted", message: "Play accepted" });
    report(onProgress, intent, "accepted", "Play accepted · settlement is automatic");
    return { intent, accepted: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Play setup failed";
    if (/reject|declin|cancel/i.test(message)) {
      updateIntent(intent, { status: "failed", message });
      throw cause;
    }
    if (requiresIntentRecovery(intent)) throw cause;
    if (intent.status === "onboarding" && intent.baseSignatures.length > 0) {
      updateIntent(intent, {
        status: "ambiguous",
        message,
      });
      throw cause;
    }
    updateIntent(intent, {
      status: "failed",
      message,
    });
    throw cause;
  }
}
