import "@/app/polyfills";
import {
  BN,
  type Wallet as AnchorWallet,
} from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  decodeEphemeralAta,
  delegateEphemeralAtaIx,
  deriveEphemeralAta,
  deriveShuttleAta,
  deriveShuttleEphemeralAta,
  deriveShuttleWalletAta,
  deriveVault,
  deriveVaultAta,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  GPLSESSION_PROGRAMS,
  SessionTokenManager,
} from "@magicblock-labs/gum-sdk";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Direction } from "@/app/lib/domain";
import {
  assetsForShares,
  guardedMinimum,
  sharesForDeposit,
} from "@/app/lib/liquidity";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import {
  decodeMarket,
  decodeProtocolConfig,
  decodeUserLiquidity,
  decodeUserPositions,
} from "@/app/lib/live/decode";
import {
  claimFallbackPayoutInstruction,
  delegateUserLiquidityInstruction,
  delegateUserPositionsInstruction,
  depositLiquidityInstruction,
  executeWithdrawalInstruction,
  initializeUserLiquidityInstruction,
  initializeUserPositionsInstruction,
  openPositionInstruction,
  requestWithdrawalInstruction,
} from "@/app/lib/live/instructions";
import {
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
  userLiquidityPda,
  userPositionsPda,
} from "@/app/lib/live/pdas";
import {
  browserSafeDepositSplTokensIx,
  browserSafeSetupAndDelegateShuttleIx,
} from "@/app/lib/live/espl-instructions";
import {
  getDelegationStatus,
  normalizeErEndpoint,
  type DelegationStatus,
} from "@/app/lib/live/router";
import {
  SESSION_DURATION_SECONDS,
  sessionKeypair,
  type StoredGameSession,
} from "@/app/lib/live/session-store";
import { accountDiscriminator } from "@/app/lib/live/decode";
import { Buffer } from "buffer";

const MAX_POSITION_MINOR = 1_000_000_000n;
const ROUTE_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 20_000;
const CONFIRMATION_TIMEOUT_MS = 90_000;
const CONFIRMATION_WARNING_MS = 15_000;
const CONFIRMATION_POLL_MS = 500;
const MAX_WALLET_COMPUTE_UNIT_LIMIT = 1_400_000;
const MAX_WALLET_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1_000_000n;
const MAX_TRANSACTION_BYTES = 1_232;
const SESSION_TOKEN_PROGRAM_ID = GPLSESSION_PROGRAMS.devnet;

export type TransactionPhase =
  | "checking"
  | "initializing-positions"
  | "provisioning-payout"
  | "depositing-collateral"
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

export interface SessionProgress {
  phase:
    | "creating"
    | "preparing-accounts"
    | "depositing"
    | "approving"
    | "ready";
  message: string;
}

export type LiquidityProgressPhase =
  | "checking"
  | "preparing-account"
  | "routing-collateral"
  | "signing"
  | "confirming"
  | "complete";

export interface LiquidityProgress {
  phase: LiquidityProgressPhase;
  message: string;
}

export interface CreateGameSessionOptions {
  existingSession?: StoredGameSession | null;
  onSessionAvailable?(session: StoredGameSession): void;
}

export async function claimFallbackPayoutFlow(
  user: PublicKey,
  signTransaction: SignTransaction,
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
  const [userEphemeralTokenAccount] = deriveEphemeralAta(
    context.user,
    context.collateralMint,
  );
  const [payoutEphemeralTokenAccount] = deriveEphemeralAta(
    context.userPositions,
    context.collateralMint,
  );
  await Promise.all([
    waitForRoute(
      context.routerEndpoint,
      context.userPositions,
      context.erEndpoint,
    ),
    waitForTokenRoute(
      context.routerEndpoint,
      userEphemeralTokenAccount,
      userTokenAccount,
      context.erEndpoint,
    ),
    waitForTokenRoute(
      context.routerEndpoint,
      payoutEphemeralTokenAccount,
      payoutEscrowTokenAccount,
      context.erEndpoint,
    ),
  ]);
  const payout = await getAccount(context.erConnection, payoutEscrowTokenAccount, "confirmed");
  if (payout.amount === 0n) return null;
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
      signTransaction,
      [instruction],
      (signature) => {
        submittedSignature = signature;
        onStatus("Claim sent. Confirming your balance…");
      },
      { label: "payout:claim" },
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
  sessionSetupLookupTable?: PublicKey;
  validator: PublicKey;
  programId: PublicKey;
  marketId: number;
  market: PublicKey;
  user: PublicKey;
  userLiquidity: PublicKey;
  userPositions: PublicKey;
  protocolConfig: PublicKey;
  collateralMint: PublicKey;
  feeAuthority: PublicKey;
  oracle: PublicKey;
}

interface PreparedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  minContextSlot: number;
  updatedAt: number;
}

export interface PreparedOpenPositionContext {
  user: PublicKey;
  programId: PublicKey;
  marketId: number;
  erEndpoint: string;
  erConnection: Connection;
  sessionSigner: Keypair;
  sessionToken: PublicKey;
  protocolConfig: PublicKey;
  market: PublicKey;
  userPositions: PublicKey;
  poolTokenAccount: PublicKey;
  derivedFeeAuthority: PublicKey;
  feeTokenAccount: PublicKey;
  userTokenAccount: PublicKey;
  payoutEscrowTokenAccount: PublicKey;
  collateralMint: PublicKey;
  priceUpdate: PublicKey;
  blockhash: PreparedBlockhash;
  blockhashRefresh?: Promise<void>;
}

export interface OpenPositionPreparationInput {
  marketId: number;
  walletAddress: string | null;
  erEndpoint?: string;
  collateralMint?: string;
  oracleAddress?: string;
}

interface OnboardingCallbacks {
  status(
    phase: "initializing-positions" | "provisioning-payout" | "depositing-collateral",
    message: string,
  ): void;
}

type SignTransaction = NonNullable<WalletContextState["signTransaction"]>;
type ProgressHandler = (progress: TransactionProgress) => void;

interface SendAndConfirmOptions {
  feePayer?: PublicKey;
  additionalSigners?: Signer[];
  label?: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function safeRpcEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid RPC endpoint>";
  }
}

function debugTransaction(
  label: string,
  message: string,
  details: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): void {
  const prefix = `[transaction:${label}] ${message}`;
  if (level === "error") {
    console.error(prefix, details);
  } else if (level === "warn") {
    console.warn(prefix, details);
  } else {
    console.info(prefix, details);
  }
}

function instructionSummary(instructions: TransactionInstruction[]): object[] {
  return instructions.map((instruction, index) => ({
    index,
    programId: instruction.programId.toBase58(),
    accountCount: instruction.keys.length,
    dataBytes: instruction.data.length,
    accounts: instruction.keys
      .map(
        (account, accountIndex) =>
          `${accountIndex}:${account.pubkey.toBase58()}:${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`,
      )
      .join(", "),
  }));
}

function sameInstruction(
  left: TransactionInstruction,
  right: TransactionInstruction,
): boolean {
  return (
    left.programId.equals(right.programId) &&
    sameBytes(left.data, right.data) &&
    left.keys.length === right.keys.length &&
    left.keys.every((key, index) => {
      const other = right.keys[index];
      return (
        Boolean(other) &&
        key.pubkey.equals(other.pubkey) &&
        key.isSigner === other.isSigner &&
        key.isWritable === other.isWritable
      );
    })
  );
}

export interface WalletTransactionValidation {
  modified: boolean;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: string;
}

export function validateWalletSignedTransaction(
  expected: Transaction,
  signed: Transaction,
  additionalSignerCount: number,
): WalletTransactionValidation {
  if (!expected.feePayer?.equals(signed.feePayer ?? PublicKey.default)) {
    throw new Error("wallet changed the fee payer");
  }
  if (expected.recentBlockhash !== signed.recentBlockhash) {
    throw new Error("wallet changed the recent blockhash");
  }
  if (sameBytes(expected.serializeMessage(), signed.serializeMessage())) {
    return { modified: false };
  }
  if (additionalSignerCount > 0) {
    throw new Error("wallet changed a message that already had an additional signature");
  }

  const computeInstructions: TransactionInstruction[] = [];
  let expectedIndex = 0;
  for (const instruction of signed.instructions) {
    const expectedInstruction = expected.instructions[expectedIndex];
    if (expectedInstruction && sameInstruction(instruction, expectedInstruction)) {
      expectedIndex += 1;
      continue;
    }
    if (!instruction.programId.equals(ComputeBudgetProgram.programId)) {
      throw new Error("wallet changed or added a non-compute-budget instruction");
    }
    computeInstructions.push(instruction);
  }
  if (expectedIndex !== expected.instructions.length) {
    throw new Error("wallet removed or reordered an application instruction");
  }
  if (computeInstructions.length === 0 || computeInstructions.length > 2) {
    throw new Error("wallet added an unexpected number of compute-budget instructions");
  }

  let computeUnitLimit: number | undefined;
  let computeUnitPriceMicroLamports: bigint | undefined;
  for (const instruction of computeInstructions) {
    if (instruction.keys.length !== 0) {
      throw new Error("wallet compute-budget instruction contains accounts");
    }
    const type = ComputeBudgetInstruction.decodeInstructionType(instruction);
    if (type === "SetComputeUnitLimit") {
      if (computeUnitLimit !== undefined) {
        throw new Error("wallet added duplicate compute-unit limits");
      }
      computeUnitLimit =
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
      if (
        computeUnitLimit < 1 ||
        computeUnitLimit > MAX_WALLET_COMPUTE_UNIT_LIMIT
      ) {
        throw new Error("wallet compute-unit limit is outside the safe range");
      }
      continue;
    }
    if (type === "SetComputeUnitPrice") {
      if (computeUnitPriceMicroLamports !== undefined) {
        throw new Error("wallet added duplicate compute-unit prices");
      }
      const decodedPrice =
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction).microLamports;
      computeUnitPriceMicroLamports =
        typeof decodedPrice === "bigint" ? decodedPrice : BigInt(decodedPrice);
      if (
        computeUnitPriceMicroLamports >
        MAX_WALLET_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS
      ) {
        throw new Error("wallet compute-unit price is outside the safe range");
      }
      continue;
    }
    throw new Error(`wallet added unsupported compute-budget instruction ${type}`);
  }

  return {
    modified: true,
    computeUnitLimit,
    computeUnitPriceMicroLamports: computeUnitPriceMicroLamports?.toString(),
  };
}

async function confirmSubmittedTransaction(
  connection: Connection,
  signature: string,
  latest: { blockhash: string; lastValidBlockHeight: number },
  label: string,
  rawTransaction?: Uint8Array,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  let lastBlockHeightCheck = 0;
  let lastRebroadcastAt = 0;
  let rebroadcastCount = 0;
  let warned = false;
  let currentBlockHeight: number | null = null;
  let lastRpcError: string | null = null;
  let shouldRebroadcast = true;

  while (Date.now() - startedAt < CONFIRMATION_TIMEOUT_MS) {
    try {
      const response = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      const status = response.value;
      const statusKey = JSON.stringify(status);
      if (statusKey !== lastStatus) {
        debugTransaction(label, "confirmation status changed", {
          signature,
          elapsedMs: Date.now() - startedAt,
          status,
        });
        lastStatus = statusKey;
      }
      shouldRebroadcast = status === null;
      if (status?.err) {
        const transaction = await connection
          .getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        debugTransaction(
          label,
          "transaction failed",
          {
            signature,
            error: status.err,
            runtimeLogs: transaction?.meta?.logMessages ?? null,
          },
          "error",
        );
        throw new Error(
          `Transaction ${signature} failed during ${label}: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        debugTransaction(label, "transaction confirmed", {
          signature,
          elapsedMs: Date.now() - startedAt,
          confirmationStatus: status.confirmationStatus,
          slot: status.slot,
        });
        return signature;
      }
      lastRpcError = null;
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith(`Transaction ${signature} failed during`)) {
        throw cause;
      }
      lastRpcError = cause instanceof Error ? cause.message : String(cause);
      shouldRebroadcast = true;
      debugTransaction(
        label,
        "confirmation status RPC request failed; retrying",
        { signature, error: lastRpcError },
        "warn",
      );
    }

    const elapsedMs = Date.now() - startedAt;
    if (
      rawTransaction &&
      shouldRebroadcast &&
      elapsedMs - lastRebroadcastAt >= 2_000
    ) {
      lastRebroadcastAt = elapsedMs;
      try {
        const rebroadcastSignature = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          maxRetries: 0,
        });
        rebroadcastCount += 1;
        if (rebroadcastSignature !== signature) {
          throw new Error(
            `RPC returned unexpected rebroadcast signature ${rebroadcastSignature}`,
          );
        }
        if (rebroadcastCount === 1 || rebroadcastCount % 5 === 0) {
          debugTransaction(label, "rebroadcast signed transaction", {
            signature,
            rebroadcastCount,
            elapsedMs,
          });
        }
      } catch (cause) {
        debugTransaction(
          label,
          "rebroadcast failed; confirmation polling continues",
          {
            signature,
            rebroadcastCount,
            elapsedMs,
            error: cause instanceof Error ? cause.message : String(cause),
          },
          "warn",
        );
      }
    }
    if (!warned && elapsedMs >= CONFIRMATION_WARNING_MS) {
      warned = true;
      debugTransaction(
        label,
        "still waiting after 15 seconds; continuing until the blockhash expires",
        { signature, lastStatus: lastStatus || null },
        "warn",
      );
    }
    if (elapsedMs - lastBlockHeightCheck >= 2_000) {
      lastBlockHeightCheck = elapsedMs;
      currentBlockHeight = await connection.getBlockHeight("confirmed").catch(() => null);
      if (
        currentBlockHeight !== null &&
        currentBlockHeight > latest.lastValidBlockHeight
      ) {
        debugTransaction(
          label,
          "transaction expired before it landed",
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
            currentBlockHeight,
            lastStatus: lastStatus || null,
            lastRpcError,
          },
          "error",
        );
        throw new Error(
          `Transaction ${signature} expired during ${label} before confirmation. Open the browser console for transaction diagnostics.`,
        );
      }
    }
    await sleep(CONFIRMATION_POLL_MS);
  }

  debugTransaction(
    label,
    "confirmation timed out",
    {
      signature,
      timeoutMs: CONFIRMATION_TIMEOUT_MS,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      currentBlockHeight,
      lastStatus: lastStatus || null,
      lastRpcError,
    },
    "error",
  );
  throw new Error(
    `Transaction ${signature} was not confirmed during ${label} within ${CONFIRMATION_TIMEOUT_MS / 1_000} seconds. Open the browser console for transaction diagnostics.`,
  );
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
  signTransaction: SignTransaction,
  instructions: TransactionInstruction[],
  onSubmitted?: (signature: string) => void,
  options?: SendAndConfirmOptions,
): Promise<string> {
  const label = options?.label ?? "wallet";
  const endpoint = safeRpcEndpoint(connection.rpcEndpoint);
  const { context: blockhashContext, value: latest } =
    await connection.getLatestBlockhashAndContext("confirmed");
  const transaction = new Transaction({
    feePayer: options?.feePayer ?? user,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  if (options?.additionalSigners?.length) {
    transaction.partialSign(...options.additionalSigners);
  }
  const expectedTransaction = Transaction.from(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
  debugTransaction(label, "prepared wallet transaction", {
    endpoint,
    feePayer: transaction.feePayer?.toBase58(),
    wallet: user.toBase58(),
    additionalSigners:
      options?.additionalSigners?.map((signer) => signer.publicKey.toBase58()) ?? [],
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    minContextSlot: blockhashContext.slot,
    instructions: instructionSummary(instructions),
  });
  const simulation = await connection.simulateTransaction(transaction);
  debugTransaction(label, "simulation completed", {
    endpoint,
    error: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs,
  }, simulation.value.err ? "error" : "info");
  if (simulation.value.err) {
    throw new Error(
      `Transaction simulation failed during ${label}: ${JSON.stringify(simulation.value.err)}. Open the browser console for runtime logs.`,
    );
  }
  let signedTransaction: Transaction;
  try {
    signedTransaction = await signTransaction(transaction);
  } catch (cause) {
    debugTransaction(
      label,
      "wallet signing failed",
      {
        endpoint,
        error: cause instanceof Error ? cause.message : String(cause),
        simulationLogs: simulation.value.logs,
      },
      "error",
    );
    throw cause;
  }
  let walletValidation: WalletTransactionValidation;
  try {
    walletValidation = validateWalletSignedTransaction(
      expectedTransaction,
      signedTransaction,
      options?.additionalSigners?.length ?? 0,
    );
  } catch (cause) {
    debugTransaction(
      label,
      "wallet returned an unsafe transaction mutation",
      {
        endpoint,
        reason: cause instanceof Error ? cause.message : String(cause),
        expected: {
          feePayer: expectedTransaction.feePayer?.toBase58(),
          blockhash: expectedTransaction.recentBlockhash,
          instructions: instructionSummary(expectedTransaction.instructions),
        },
        signed: {
          feePayer: signedTransaction.feePayer?.toBase58(),
          blockhash: signedTransaction.recentBlockhash,
          instructions: instructionSummary(signedTransaction.instructions),
        },
      },
      "error",
    );
    throw new Error(
      `Wallet changed the transaction message during ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (walletValidation.modified) {
    debugTransaction(label, "accepted safe wallet compute-budget adjustment", {
      endpoint,
      ...walletValidation,
    });
  }
  const walletSignature = signedTransaction.signatures.find(
    ({ publicKey }) => publicKey.equals(user),
  )?.signature;
  if (!walletSignature) {
    throw new Error(`Wallet did not sign the transaction during ${label}`);
  }
  const rawTransaction = signedTransaction.serialize();
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      minContextSlot: blockhashContext.slot,
    });
  } catch (cause) {
    debugTransaction(
      label,
      "direct RPC submission failed",
      {
        endpoint,
        error: cause instanceof Error ? cause.message : String(cause),
        simulationLogs: simulation.value.logs,
      },
      "error",
    );
    throw cause;
  }
  debugTransaction(label, "transaction submitted directly to configured RPC", {
    endpoint,
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  onSubmitted?.(signature);
  return confirmSubmittedTransaction(
    connection,
    signature,
    latest,
    label,
    rawTransaction,
  );
}

function hasSignature(signature: Uint8Array | null | undefined): boolean {
  return Boolean(signature?.some((byte) => byte !== 0));
}

async function loadSetupLookupTable(
  connection: Connection,
  address: PublicKey,
): Promise<AddressLookupTableAccount> {
  const response = await connection.getAddressLookupTable(address, {
    commitment: "confirmed",
  });
  if (!response.value) {
    throw new Error(`Session setup lookup table ${address.toBase58()} is missing`);
  }
  if (response.value.state.deactivationSlot !== BigInt("18446744073709551615")) {
    throw new Error(`Session setup lookup table ${address.toBase58()} is deactivated`);
  }
  return response.value;
}

async function sendBaseSetupAndConfirm(
  context: LiveWriteContext,
  signTransaction: SignTransaction,
  instructions: TransactionInstruction[],
  additionalSigners: Signer[],
  label = "session:base-setup",
): Promise<string | null> {
  if (instructions.length === 0) return null;
  const connection = context.baseConnection;
  const user = context.user;
  const { context: blockhashContext, value: latest } =
    await connection.getLatestBlockhashAndContext("confirmed");
  const legacy = new Transaction({
    feePayer: user,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  if (additionalSigners.length > 0) legacy.partialSign(...additionalSigners);

  const requiredSignatureCount = legacy.compileMessage().header.numRequiredSignatures;
  const legacyBytes =
    legacy.serializeMessage().length +
    1 +
    requiredSignatureCount * 64;
  if (legacyBytes <= MAX_TRANSACTION_BYTES) {
    return sendAndConfirm(
      connection,
      user,
      signTransaction,
      instructions,
      undefined,
      {
        additionalSigners,
        label,
      },
    );
  }

  if (!context.sessionSetupLookupTable) {
    throw new Error(
      `Base setup is ${legacyBytes} bytes and needs NEXT_PUBLIC_SESSION_SETUP_LOOKUP_TABLE`,
    );
  }
  const lookupTable = await loadSetupLookupTable(
    connection,
    context.sessionSetupLookupTable,
  );
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message([lookupTable]);
  const transaction = new VersionedTransaction(message);
  if (additionalSigners.length > 0) transaction.sign(additionalSigners);
  const serializedBeforeWallet = transaction.serialize();
  if (serializedBeforeWallet.length > MAX_TRANSACTION_BYTES) {
    throw new Error(
      `Base setup remains ${serializedBeforeWallet.length} bytes with lookup table ${lookupTable.key.toBase58()}`,
    );
  }

  debugTransaction(label, "prepared versioned wallet transaction", {
    endpoint: safeRpcEndpoint(connection.rpcEndpoint),
    feePayer: user.toBase58(),
    wallet: user.toBase58(),
    additionalSigners: additionalSigners.map((signer) => signer.publicKey.toBase58()),
    lookupTable: lookupTable.key.toBase58(),
    serializedBytes: serializedBeforeWallet.length,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    minContextSlot: blockhashContext.slot,
    instructions: instructionSummary(instructions),
  });
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    minContextSlot: blockhashContext.slot,
    sigVerify: false,
  });
  debugTransaction(label, "simulation completed", {
    endpoint: safeRpcEndpoint(connection.rpcEndpoint),
    error: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs,
  }, simulation.value.err ? "error" : "info");
  if (simulation.value.err) {
    throw new Error(
      `Transaction simulation failed during ${label}: ${JSON.stringify(simulation.value.err)}. Open the browser console for runtime logs.`,
    );
  }

  const expectedMessage = transaction.message.serialize();
  const signedTransaction = await signTransaction(transaction);
  if (!(signedTransaction instanceof VersionedTransaction)) {
    throw new Error(`Wallet returned the wrong transaction type during ${label}`);
  }
  if (!sameBytes(expectedMessage, signedTransaction.message.serialize())) {
    throw new Error(`Wallet changed the versioned transaction message during ${label}`);
  }
  const requiredSigners = signedTransaction.message.staticAccountKeys.slice(
    0,
    signedTransaction.message.header.numRequiredSignatures,
  );
  for (const expectedSigner of [user, ...additionalSigners.map((signer) => signer.publicKey)]) {
    const signerIndex = requiredSigners.findIndex((key) => key.equals(expectedSigner));
    if (signerIndex < 0 || !hasSignature(signedTransaction.signatures[signerIndex])) {
      throw new Error(
        `Missing ${expectedSigner.equals(user) ? "wallet" : "additional"} signature during ${label}`,
      );
    }
  }

  const rawTransaction = signedTransaction.serialize();
  const signature = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    minContextSlot: blockhashContext.slot,
  });
  debugTransaction(label, "transaction submitted directly to configured RPC", {
    endpoint: safeRpcEndpoint(connection.rpcEndpoint),
    signature,
    lookupTable: lookupTable.key.toBase58(),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  return confirmSubmittedTransaction(
    connection,
    signature,
    latest,
    label,
    rawTransaction,
  );
}

function sessionTokenPda(
  programId: PublicKey,
  sessionSigner: PublicKey,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("session_token_v2"),
      programId.toBuffer(),
      sessionSigner.toBuffer(),
      user.toBuffer(),
    ],
    SESSION_TOKEN_PROGRAM_ID,
  )[0];
}

function assertSessionTokenAccount(
  data: Buffer,
  session: StoredGameSession,
  user: PublicKey,
  programId: PublicKey,
): void {
  const expectedLength = 8 + 32 * 4 + 8;
  if (data.length < expectedLength) throw new Error("Session token account is truncated");
  if (!data.subarray(0, 8).equals(accountDiscriminator("SessionTokenV2"))) {
    throw new Error("Session token account discriminator mismatch");
  }
  const signer = sessionKeypair(session).publicKey;
  if (!new PublicKey(data.subarray(8, 40)).equals(user)) {
    throw new Error("Session token authority does not match the connected wallet");
  }
  if (!new PublicKey(data.subarray(40, 72)).equals(programId)) {
    throw new Error("Session token targets a different program");
  }
  if (!new PublicKey(data.subarray(72, 104)).equals(signer)) {
    throw new Error("Session token signer does not match this browser session");
  }
  const validUntil = Number(data.readBigInt64LE(136));
  if (validUntil !== session.validUntil || validUntil <= Math.floor(Date.now() / 1_000)) {
    throw new Error("Session token has expired");
  }
}

function assertStoredSessionIdentity(
  user: PublicKey,
  programId: PublicKey,
  session: StoredGameSession,
): PublicKey {
  if (
    session.user !== user.toBase58() ||
    session.programId !== programId.toBase58()
  ) {
    throw new Error("Stored session does not belong to this wallet and program");
  }
  const signer = sessionKeypair(session).publicKey;
  const expectedToken = sessionTokenPda(
    programId,
    signer,
    user,
  );
  if (!expectedToken.equals(new PublicKey(session.sessionToken))) {
    throw new Error("Stored session token address is invalid");
  }
  return expectedToken;
}

async function validateSessionTokenInContext(
  connection: Connection,
  user: PublicKey,
  programId: PublicKey,
  session: StoredGameSession,
): Promise<void> {
  const expectedToken = assertStoredSessionIdentity(user, programId, session);
  const tokenInfo = await connection.getAccountInfo(
    expectedToken,
    "confirmed",
  );
  if (!tokenInfo || !tokenInfo.owner.equals(SESSION_TOKEN_PROGRAM_ID)) {
    throw new Error("Session token is missing from the base layer");
  }
  assertSessionTokenAccount(
    Buffer.from(tokenInfo.data),
    session,
    user,
    programId,
  );
}

function anchorBuildWallet(user: PublicKey): AnchorWallet {
  return {
    publicKey: user,
    signTransaction: async <T extends Transaction>(transaction: T) => transaction,
    signAllTransactions: async <T extends Transaction>(transactions: T[]) => transactions,
  } as AnchorWallet;
}

async function waitForRoute(
  routerEndpoint: string,
  account: PublicKey,
  expectedEndpoint: string,
): Promise<void> {
  return waitForRouteCandidates(
    routerEndpoint,
    [account],
    expectedEndpoint,
  );
}

async function waitForTokenRoute(
  routerEndpoint: string,
  ephemeralTokenAccount: PublicKey,
  tokenAccount: PublicKey,
  expectedEndpoint: string,
): Promise<void> {
  return waitForRouteCandidates(
    routerEndpoint,
    [ephemeralTokenAccount, tokenAccount],
    expectedEndpoint,
  );
}

async function waitForRouteCandidates(
  routerEndpoint: string,
  accounts: PublicKey[],
  expectedEndpoint: string,
): Promise<void> {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  let lastError = "delegation has not reached the router";
  while (Date.now() < deadline) {
    try {
      const routes = await Promise.all(
        accounts.map((account) =>
          getDelegationStatus(routerEndpoint, account.toBase58()),
        ),
      );
      for (const route of routes) {
        if (route.isDelegated && route.fqdn) {
          const actual = normalizeErEndpoint(route.fqdn);
          if (actual === expectedEndpoint) return;
          lastError = `account is routed to ${actual}, expected ${expectedEndpoint}`;
        }
      }
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : lastError;
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out waiting for ${accounts.map((account) => account.toBase58()).join(" or ")}: ${lastError}`,
  );
}

async function getTokenRoute(
  routerEndpoint: string,
  ephemeralTokenAccount: PublicKey,
  tokenAccount: PublicKey,
): Promise<DelegationStatus | null> {
  const routes = await Promise.all(
    [ephemeralTokenAccount, tokenAccount].map((account) =>
      getDelegationStatus(routerEndpoint, account.toBase58()).catch(() => null),
    ),
  );
  const delegated = routes.filter(
    (route): route is DelegationStatus & { fqdn: string } =>
      Boolean(route?.isDelegated && route.fqdn),
  );
  const endpoints = new Set(
    delegated.map((route) => normalizeErEndpoint(route.fqdn)),
  );
  if (endpoints.size > 1) {
    throw new Error("Ephemeral token route representations disagree");
  }
  return delegated[0] ?? null;
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
    sessionSetupLookupTable: config.sessionSetupLookupTable,
    validator: await rpcIdentity(erEndpoint),
    programId: config.programId,
    marketId: config.marketId,
    market,
    user,
    userLiquidity: userLiquidityPda(config.programId, user),
    userPositions: userPositionsPda(config.programId, user),
    protocolConfig,
    collateralMint,
    feeAuthority: feeAuthorityPda(config.programId, market),
    oracle: new PublicKey(decodedMarket.oracle),
  };
}

async function latestPreparedBlockhash(
  connection: Connection,
): Promise<PreparedBlockhash> {
  const { context, value } = await connection.getLatestBlockhashAndContext(
    "processed",
  );
  return {
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
    minContextSlot: context.slot,
    updatedAt: Date.now(),
  };
}

export async function prepareOpenPosition(
  user: PublicKey,
  session: StoredGameSession,
  snapshot: OpenPositionPreparationInput,
): Promise<PreparedOpenPositionContext> {
  if (
    snapshot.walletAddress !== user.toBase58() ||
    !snapshot.erEndpoint ||
    !snapshot.collateralMint ||
    !snapshot.oracleAddress
  ) {
    throw new Error("The live play context is not ready");
  }
  if (
    !session.setupComplete ||
    session.validUntil <= Math.floor(Date.now() / 1_000)
  ) {
    throw new Error("A valid session is required before playing");
  }

  const config = readClientLiveConfig();
  if (
    snapshot.marketId !== config.marketId ||
    session.programId !== config.programId.toBase58()
  ) {
    throw new Error("The session and live Market configuration do not match");
  }

  const sessionSigner = sessionKeypair(session);
  const sessionToken = assertStoredSessionIdentity(
    user,
    config.programId,
    session,
  );
  const collateralMint = new PublicKey(snapshot.collateralMint);
  const market = marketPda(config.programId, config.marketId);
  const userPositions = userPositionsPda(config.programId, user);
  const derivedFeeAuthority = feeAuthorityPda(config.programId, market);
  const erConnection = new Connection(snapshot.erEndpoint, "processed");

  return {
    user,
    programId: config.programId,
    marketId: config.marketId,
    erEndpoint: snapshot.erEndpoint,
    erConnection,
    sessionSigner,
    sessionToken,
    protocolConfig: protocolConfigPda(config.programId),
    market,
    userPositions,
    poolTokenAccount: getAssociatedTokenAddressSync(
      collateralMint,
      market,
      true,
    ),
    derivedFeeAuthority,
    feeTokenAccount: getAssociatedTokenAddressSync(
      collateralMint,
      derivedFeeAuthority,
      true,
    ),
    userTokenAccount: getAssociatedTokenAddressSync(collateralMint, user),
    payoutEscrowTokenAccount: getAssociatedTokenAddressSync(
      collateralMint,
      userPositions,
      true,
    ),
    collateralMint,
    priceUpdate: new PublicKey(snapshot.oracleAddress),
    blockhash: await latestPreparedBlockhash(erConnection),
  };
}

export async function refreshPreparedOpenPosition(
  prepared: PreparedOpenPositionContext,
): Promise<void> {
  if (prepared.blockhashRefresh) return prepared.blockhashRefresh;
  prepared.blockhashRefresh = latestPreparedBlockhash(prepared.erConnection)
    .then((blockhash) => {
      prepared.blockhash = blockhash;
    })
    .finally(() => {
      prepared.blockhashRefresh = undefined;
    });
  return prepared.blockhashRefresh;
}

export async function validateGameSession(
  user: PublicKey,
  session: StoredGameSession,
): Promise<{ remainingAllowanceMinor: bigint }> {
  const context = await loadWriteContext(user);
  await validateSessionTokenInContext(
    context.baseConnection,
    user,
    context.programId,
    session,
  );
  const signer = sessionKeypair(session).publicKey;

  const userTokenAccount = getAssociatedTokenAddressSync(context.collateralMint, user);
  const [userEphemeralTokenAccount] = deriveEphemeralAta(
    user,
    context.collateralMint,
  );
  await waitForTokenRoute(
    context.routerEndpoint,
    userEphemeralTokenAccount,
    userTokenAccount,
    context.erEndpoint,
  );
  const token = await getAccount(context.erConnection, userTokenAccount, "confirmed");
  if (
    !token.owner.equals(user) ||
    !token.mint.equals(context.collateralMint) ||
    !token.delegate?.equals(signer)
  ) {
    throw new Error("Session signer is not the current collateral delegate");
  }
  if (token.delegatedAmount === 0n) throw new Error("Session spending allowance is exhausted");
  return { remainingAllowanceMinor: token.delegatedAmount };
}

export async function validateGameSessionToken(
  user: PublicKey,
  session: StoredGameSession,
): Promise<void> {
  const config = readClientLiveConfig();
  await validateSessionTokenInContext(
    new Connection(config.baseRpcEndpoint, "confirmed"),
    user,
    config.programId,
    session,
  );
}

export async function createGameSessionFlow(
  user: PublicKey,
  allowanceUsd: number,
  signTransaction: SignTransaction,
  onProgress: (progress: SessionProgress) => void,
  options: CreateGameSessionOptions = {},
): Promise<StoredGameSession> {
  if (!Number.isFinite(allowanceUsd) || allowanceUsd < 1 || allowanceUsd > 1_000) {
    throw new Error("One-hour play allowance must be between 1 and 1,000 USDC");
  }
  const allowanceMinor = BigInt(Math.round(allowanceUsd * 1_000_000));
  const context = await loadWriteContext(user);
  let session: StoredGameSession;
  let sessionInstructions: TransactionInstruction[] = [];
  let sessionSigners: Signer[] = [];
  if (options.existingSession) {
    await validateSessionTokenInContext(
      context.baseConnection,
      user,
      context.programId,
      options.existingSession,
    );
    if (
      options.existingSession.setupComplete &&
      options.existingSession.allowanceMinor === allowanceMinor.toString()
    ) {
      await validateGameSession(user, options.existingSession);
      options.onSessionAvailable?.(options.existingSession);
      onProgress({
        phase: "ready",
        message: "Existing session is ready · no setup transaction needed",
      });
      return options.existingSession;
    }
    session = {
      ...options.existingSession,
      allowanceMinor: allowanceMinor.toString(),
      setupComplete: false,
    };
    options.onSessionAvailable?.(session);
    onProgress({
      phase: "preparing-accounts",
      message: "Step 1 of 2 · Resuming base-layer setup…",
    });
  } else {
    const signer = Keypair.generate();
    const chainSlot = await context.baseConnection.getSlot("confirmed");
    const chainTime = await context.baseConnection.getBlockTime(chainSlot);
    const validUntil = (chainTime ?? Math.floor(Date.now() / 1_000)) + SESSION_DURATION_SECONDS;
    const sessionToken = sessionTokenPda(context.programId, signer.publicKey, user);
    const manager = new SessionTokenManager(
      anchorBuildWallet(user),
      context.baseConnection,
    );

    onProgress({ phase: "creating", message: "Step 1 of 2 · Preparing the base-layer deposit…" });
    const createTransaction = await manager.program.methods
      .createSessionV2(false, new BN(validUntil), new BN(0))
      .accounts({
        targetProgram: context.programId,
        sessionSigner: signer.publicKey,
        feePayer: user,
        authority: user,
      })
      .transaction();
    sessionInstructions = createTransaction.instructions;
    sessionSigners = [signer];
    session = {
      user: user.toBase58(),
      programId: context.programId.toBase58(),
      sessionToken: sessionToken.toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      allowanceMinor: allowanceMinor.toString(),
      validUntil,
      setupComplete: false,
    };
    options.onSessionAvailable?.(session);
  }

  const callbacks: OnboardingCallbacks = {
    status: (phase, message) => {
      onProgress({
        phase: phase === "depositing-collateral" ? "depositing" : "preparing-accounts",
        message,
      });
    },
  };
  const positions = await planUserPositions(context, callbacks);
  const fallback = await planFallbackBalance(context, callbacks);
  const collateral = await planCollateralBalance(
    context,
    allowanceMinor,
    callbacks,
  );
  const baseInstructions = [
    ...sessionInstructions,
    ...positions.instructions,
    ...fallback.instructions,
    ...collateral.instructions,
  ];
  if (baseInstructions.length > 0) {
    onProgress({
      phase: "preparing-accounts",
      message: "Step 1 of 2 · Setting up accounts and depositing to the arena…",
    });
  }
  await sendBaseSetupAndConfirm(
    context,
    signTransaction,
    baseInstructions,
    sessionSigners,
  );
  await Promise.all([
    positions.finalize(),
    fallback.finalize(),
    collateral.finalize(),
  ]);
  onProgress({
    phase: "approving",
    message: `Step 2 of 2 · Approving a ${allowanceUsd.toFixed(2)} USDC play allowance on the ER…`,
  });
  await sendAndConfirm(
    context.erConnection,
    user,
    signTransaction,
    [
      createApproveCheckedInstruction(
        collateral.ata,
        context.collateralMint,
        sessionKeypair(session).publicKey,
        user,
        allowanceMinor,
        6,
      ),
    ],
    undefined,
    { label: "session:approve-collateral" },
  );

  const readySession = { ...session, setupComplete: true };
  await validateGameSession(user, readySession);
  options.onSessionAvailable?.(readySession);
  onProgress({ phase: "ready", message: "Session ready · plays no longer need wallet prompts" });
  return readySession;
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

interface BaseSetupPlan {
  instructions: TransactionInstruction[];
  finalize(): Promise<void>;
}

interface TokenSetupPlan extends BaseSetupPlan {
  eata: PublicKey;
  ata: PublicKey;
}

async function planUserPositions(
  context: LiveWriteContext,
  callbacks: OnboardingCallbacks,
): Promise<BaseSetupPlan> {
  const info = await context.baseConnection.getAccountInfo(context.userPositions, "confirmed");
  if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
    return {
      instructions: [],
      finalize: () =>
        waitForRoute(context.routerEndpoint, context.userPositions, context.erEndpoint),
    };
  }
  if (info && !info.owner.equals(context.programId)) {
    throw new Error("UserPositions has an unexpected base-layer owner");
  }
  callbacks.status(
    "initializing-positions",
    info ? "Routing your play slots to the arena…" : "Creating your play slots…",
  );
  const instructions = info
    ? [delegateUserPositionsInstruction(context.programId, context.user, context.userPositions, context.validator)]
    : [
        initializeUserPositionsInstruction(context.programId, context.user, context.userPositions),
        delegateUserPositionsInstruction(context.programId, context.user, context.userPositions, context.validator),
      ];
  return {
    instructions,
    finalize: () =>
      waitForRoute(context.routerEndpoint, context.userPositions, context.erEndpoint),
  };
}

async function planFallbackBalance(
  context: LiveWriteContext,
  callbacks: OnboardingCallbacks,
): Promise<TokenSetupPlan> {
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
    callbacks.status("provisioning-payout", "Preparing your protected payout account…");
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
  return {
    eata,
    ata,
    instructions,
    finalize: async () => {
      await waitForTokenRoute(
        context.routerEndpoint,
        eata,
        ata,
        context.erEndpoint,
      );
      await waitForTokenAmount(context.erConnection, ata, 0n);
      const account = await getAccount(context.erConnection, ata, "confirmed");
      if (
        !account.owner.equals(context.userPositions) ||
        !account.mint.equals(context.collateralMint)
      ) {
        throw new Error("Fallback payout ATA owner or mint mismatch on the ER");
      }
    },
  };
}

async function planCollateralBalance(
  context: LiveWriteContext,
  amount: bigint,
  callbacks: OnboardingCallbacks,
): Promise<TokenSetupPlan> {
  const [eata] = deriveEphemeralAta(context.user, context.collateralMint);
  const ata = getAssociatedTokenAddressSync(context.collateralMint, context.user);
  const routed = await getTokenRoute(
    context.routerEndpoint,
    eata,
    ata,
  );
  const isDelegated = Boolean(routed?.isDelegated && routed.fqdn);
  let erAmount = 0n;
  if (isDelegated) {
    const actualEndpoint = normalizeErEndpoint(routed!.fqdn!);
    if (actualEndpoint !== context.erEndpoint) {
      throw new Error(`Your collateral is routed to ${actualEndpoint}, not the Market ER`);
    }
    erAmount = (await getAccount(context.erConnection, ata, "confirmed").catch(() => null))?.amount ?? 0n;
  }
  if (erAmount >= amount) {
    return {
      eata,
      ata,
      instructions: [],
      finalize: async () => {
        await waitForTokenRoute(
          context.routerEndpoint,
          eata,
          ata,
          context.erEndpoint,
        );
        await waitForTokenAmount(context.erConnection, ata, amount);
      },
    };
  }

  const shortfall = amount - erAmount;
  const baseToken = await getAccount(context.baseConnection, ata, "confirmed").catch(() => null);
  if (!baseToken || baseToken.amount < shortfall) {
    const available = baseToken?.amount ?? 0n;
    throw new Error(
      `Base wallet needs at least ${Number(shortfall) / 1_000_000} USDC; available ${Number(available) / 1_000_000}`,
    );
  }
  callbacks.status(
    "depositing-collateral",
    `Moving ${Number(shortfall) / 1_000_000} USDC into the arena…`,
  );

  let instructions: TransactionInstruction[];
  if (isDelegated) {
    const shuttleId = randomU32();
    const [shuttleEata] = deriveShuttleEphemeralAta(context.user, context.collateralMint, shuttleId);
    const [shuttleAta] = deriveShuttleAta(shuttleEata, context.collateralMint);
    const shuttleWalletAta = deriveShuttleWalletAta(context.collateralMint, shuttleEata);
    instructions = [
      browserSafeSetupAndDelegateShuttleIx(
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
      browserSafeDepositSplTokensIx(
        eata,
        vault,
        context.collateralMint,
        ata,
        vaultAta,
        context.user,
        shortfall,
      ),
      delegateEphemeralAtaIx(context.user, eata, context.validator),
    );
  }

  return {
    eata,
    ata,
    instructions,
    finalize: async () => {
      await waitForTokenRoute(
        context.routerEndpoint,
        eata,
        ata,
        context.erEndpoint,
      );
      await waitForTokenAmount(context.erConnection, ata, amount);
    },
  };
}

async function planUserLiquidity(
  context: LiveWriteContext,
  onProgress: (progress: LiquidityProgress) => void,
): Promise<BaseSetupPlan> {
  const info = await context.baseConnection.getAccountInfo(
    context.userLiquidity,
    "confirmed",
  );
  if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
    return {
      instructions: [],
      finalize: () =>
        waitForRoute(
          context.routerEndpoint,
          context.userLiquidity,
          context.erEndpoint,
        ),
    };
  }
  if (info && !info.owner.equals(context.programId)) {
    throw new Error("UserLiquidity has an unexpected base-layer owner");
  }
  onProgress({
    phase: "preparing-account",
    message: info
      ? "Routing your liquidity account to the market…"
      : "Creating your liquidity account…",
  });
  const instructions = info
    ? [
        delegateUserLiquidityInstruction(
          context.programId,
          context.user,
          context.userLiquidity,
          context.validator,
        ),
      ]
    : [
        initializeUserLiquidityInstruction(
          context.programId,
          context.user,
          context.userLiquidity,
        ),
        delegateUserLiquidityInstruction(
          context.programId,
          context.user,
          context.userLiquidity,
          context.validator,
        ),
      ];
  return {
    instructions,
    finalize: async () => {
      await waitForRoute(
        context.routerEndpoint,
        context.userLiquidity,
        context.erEndpoint,
      );
      const erInfo = await context.erConnection.getAccountInfo(
        context.userLiquidity,
        "confirmed",
      );
      if (!erInfo?.owner.equals(context.programId)) {
        throw new Error("UserLiquidity did not become available on the Market ER");
      }
      decodeUserLiquidity(Buffer.from(erInfo.data));
    },
  };
}

interface LiquidityWriteState {
  market: ReturnType<typeof decodeMarket>;
  poolTokenAccount: PublicKey;
  userTokenAccount: PublicKey;
  poolBalance: bigint;
  userShares: bigint;
  pendingWithdrawalShares: bigint;
}

async function readLiquidityWriteState(
  context: LiveWriteContext,
): Promise<LiquidityWriteState> {
  const poolTokenAccount = getAssociatedTokenAddressSync(
    context.collateralMint,
    context.market,
    true,
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    context.collateralMint,
    context.user,
  );
  const [marketInfo, liquidityInfo, pool] = await Promise.all([
    context.erConnection.getAccountInfo(context.market, "confirmed"),
    context.erConnection.getAccountInfo(context.userLiquidity, "confirmed"),
    getAccount(context.erConnection, poolTokenAccount, "confirmed"),
  ]);
  if (!marketInfo?.owner.equals(context.programId)) {
    throw new Error("Market has the wrong owner on the routed ER");
  }
  if (!liquidityInfo?.owner.equals(context.programId)) {
    throw new Error("UserLiquidity has the wrong owner on the routed ER");
  }
  if (
    !pool.owner.equals(context.market) ||
    !pool.mint.equals(context.collateralMint)
  ) {
    throw new Error("Market pool token account owner or mint mismatch");
  }
  const market = decodeMarket(Buffer.from(marketInfo.data));
  if (market.marketId !== context.marketId) {
    throw new Error("Routed Market ID mismatch");
  }
  const entry = decodeUserLiquidity(Buffer.from(liquidityInfo.data))
    .find((candidate) => candidate.marketId === context.marketId);
  return {
    market,
    poolTokenAccount,
    userTokenAccount,
    poolBalance: pool.amount,
    userShares: entry?.shares ?? 0n,
    pendingWithdrawalShares: entry?.pendingWithdrawalShares ?? 0n,
  };
}

function requireLiquidityWindow(
  market: ReturnType<typeof decodeMarket>,
  operation: "deposit" | "withdraw",
): void {
  if (market.activePositions !== 0 || market.openCollateral !== 0n) {
    throw new Error("Liquidity changes resume when all open positions settle");
  }
  if (operation === "deposit" && market.mode !== "open") {
    throw new Error("Deposits are paused while the Market is close-only");
  }
}

function liquidityInstructionAccounts(
  context: LiveWriteContext,
  state: LiquidityWriteState,
) {
  return {
    user: context.user,
    protocolConfig: context.protocolConfig,
    market: context.market,
    userLiquidity: context.userLiquidity,
    poolTokenAccount: state.poolTokenAccount,
    userTokenAccount: state.userTokenAccount,
    collateralMint: context.collateralMint,
  };
}

export async function addLiquidityFlow(
  user: PublicKey,
  signTransaction: SignTransaction,
  amount: bigint,
  onProgress: (progress: LiquidityProgress) => void,
): Promise<string> {
  if (amount <= 0n || amount >= (1n << 64n)) {
    throw new Error("Enter a valid USDC amount");
  }
  onProgress({ phase: "checking", message: "Checking the Market and your balances…" });
  const context = await loadWriteContext(user);
  const initialMarketInfo = await context.erConnection.getAccountInfo(
    context.market,
    "confirmed",
  );
  if (!initialMarketInfo?.owner.equals(context.programId)) {
    throw new Error("Market is unavailable on its routed ER");
  }
  requireLiquidityWindow(
    decodeMarket(Buffer.from(initialMarketInfo.data)),
    "deposit",
  );

  const userLiquidity = await planUserLiquidity(context, onProgress);
  if (userLiquidity.instructions.length > 0) {
    await sendBaseSetupAndConfirm(
      context,
      signTransaction,
      userLiquidity.instructions,
      [],
      "liquidity:account-setup",
    );
  }
  await userLiquidity.finalize();

  const collateral = await planCollateralBalance(context, amount, {
    status: (_phase, message) => {
      onProgress({ phase: "routing-collateral", message });
    },
  });
  if (collateral.instructions.length > 0) {
    await sendBaseSetupAndConfirm(
      context,
      signTransaction,
      collateral.instructions,
      [],
      "liquidity:route-collateral",
    );
  }
  await collateral.finalize();

  const state = await readLiquidityWriteState(context);
  requireLiquidityWindow(state.market, "deposit");
  if (state.pendingWithdrawalShares > 0n) {
    throw new Error("Complete the pending withdrawal before adding liquidity");
  }
  const estimatedShares = sharesForDeposit(
    amount,
    state.poolBalance,
    state.market.totalShares,
  );
  if (estimatedShares <= 0n) {
    throw new Error("This amount is too small to mint a liquidity share");
  }
  onProgress({
    phase: "signing",
    message: "Approve the liquidity deposit in your wallet…",
  });
  const signature = await sendAndConfirm(
    context.erConnection,
    user,
    signTransaction,
    [
      depositLiquidityInstruction(
        context.programId,
        liquidityInstructionAccounts(context, state),
        amount,
        guardedMinimum(estimatedShares),
      ),
    ],
    () => {
      onProgress({
        phase: "confirming",
        message: "Deposit sent. Confirming your new shares…",
      });
    },
    { label: "liquidity:deposit" },
  );
  onProgress({ phase: "complete", message: "Liquidity added" });
  return signature;
}

export async function removeLiquidityFlow(
  user: PublicKey,
  signTransaction: SignTransaction,
  shares: bigint,
  onProgress: (progress: LiquidityProgress) => void,
): Promise<string> {
  if (shares <= 0n || shares >= (1n << 128n)) {
    throw new Error("Enter a valid amount to remove");
  }
  onProgress({ phase: "checking", message: "Checking your shares and the Market…" });
  const context = await loadWriteContext(user);
  await Promise.all([
    waitForRoute(
      context.routerEndpoint,
      context.userLiquidity,
      context.erEndpoint,
    ),
    waitForTokenRoute(
      context.routerEndpoint,
      deriveEphemeralAta(context.user, context.collateralMint)[0],
      getAssociatedTokenAddressSync(context.collateralMint, context.user),
      context.erEndpoint,
    ),
  ]);
  const state = await readLiquidityWriteState(context);
  requireLiquidityWindow(state.market, "withdraw");
  if (state.pendingWithdrawalShares > 0n) {
    throw new Error("A withdrawal is already pending");
  }
  if (shares > state.userShares) {
    throw new Error("The requested withdrawal exceeds your shares");
  }
  const estimatedAssets = assetsForShares(
    shares,
    state.poolBalance,
    state.market.totalShares,
  );
  if (estimatedAssets <= 0n) {
    throw new Error("This share amount is too small to withdraw");
  }
  const accounts = liquidityInstructionAccounts(context, state);
  onProgress({
    phase: "signing",
    message: "Approve the combined removal in your wallet…",
  });
  const signature = await sendAndConfirm(
    context.erConnection,
    user,
    signTransaction,
    [
      requestWithdrawalInstruction(
        context.programId,
        accounts,
        shares,
        guardedMinimum(estimatedAssets),
      ),
      executeWithdrawalInstruction(context.programId, accounts),
    ],
    () => {
      onProgress({
        phase: "confirming",
        message: "Removal sent. Confirming your USDC balance…",
      });
    },
    { label: "liquidity:remove" },
  );
  onProgress({ phase: "complete", message: "Liquidity removed" });
  return signature;
}

export async function completePendingLiquidityWithdrawalFlow(
  user: PublicKey,
  signTransaction: SignTransaction,
  onProgress: (progress: LiquidityProgress) => void,
): Promise<string> {
  onProgress({ phase: "checking", message: "Checking the pending withdrawal…" });
  const context = await loadWriteContext(user);
  await Promise.all([
    waitForRoute(
      context.routerEndpoint,
      context.userLiquidity,
      context.erEndpoint,
    ),
    waitForTokenRoute(
      context.routerEndpoint,
      deriveEphemeralAta(context.user, context.collateralMint)[0],
      getAssociatedTokenAddressSync(context.collateralMint, context.user),
      context.erEndpoint,
    ),
  ]);
  const state = await readLiquidityWriteState(context);
  requireLiquidityWindow(state.market, "withdraw");
  if (state.pendingWithdrawalShares <= 0n) {
    throw new Error("There is no pending withdrawal to complete");
  }
  onProgress({
    phase: "signing",
    message: "Approve completion of the pending withdrawal…",
  });
  const signature = await sendAndConfirm(
    context.erConnection,
    user,
    signTransaction,
    [
      executeWithdrawalInstruction(
        context.programId,
        liquidityInstructionAccounts(context, state),
      ),
    ],
    () => {
      onProgress({
        phase: "confirming",
        message: "Withdrawal sent. Confirming your USDC balance…",
      });
    },
    { label: "liquidity:complete-pending" },
  );
  onProgress({ phase: "complete", message: "Pending withdrawal completed" });
  return signature;
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
  session: StoredGameSession,
  prepared: PreparedOpenPositionContext,
  quote: {
    rawPrice: string;
    nextPositionNonce: number;
  },
  onProgress: ProgressHandler,
): Promise<OpenFlowResult> {
  const clickStartedAt = globalThis.performance?.now() ?? Date.now();
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1_000) {
    throw new Error("Play amount must be between 1 and 1,000 USDC");
  }
  const collateral = BigInt(Math.round(amountUsd * 1_000_000));
  if (collateral > MAX_POSITION_MINOR) throw new Error("Play amount exceeds the contract maximum");
  if (
    session.user !== user.toBase58() ||
    !session.setupComplete ||
    session.validUntil <= Math.floor(Date.now() / 1_000) ||
    !prepared.user.equals(user) ||
    prepared.marketId < 0 ||
    session.programId !== prepared.programId.toBase58() ||
    !prepared.sessionSigner.publicKey.equals(sessionKeypair(session).publicKey)
  ) {
    throw new Error("A valid session is required before playing");
  }
  if (
    !Number.isInteger(quote.nextPositionNonce) ||
    quote.nextPositionNonce < 0 ||
    quote.nextPositionNonce > 0xffff_ffff ||
    !/^[1-9][0-9]*$/.test(quote.rawPrice)
  ) {
    throw new Error("The live Market quote is not ready");
  }

  const existing = loadOpenIntent(user.toBase58(), prepared.marketId);
  if (existing && requiresIntentRecovery(existing)) {
    throw new Error("Check the previous play before sending another one");
  }

  let intent = createOpenIntent(
    user.toBase58(),
    prepared.marketId,
    direction,
    collateral,
    randomTaskSalt(),
  );
  intent = saveOpenIntent(intent);
  try {
    const rawPrice = BigInt(quote.rawPrice);
    const taskSalt = hexToBytes(intent.taskSaltHex);
    const slippage = rawPrice / 2_000n > 0n ? rawPrice / 2_000n : 1n;
    intent = updateIntent(intent, {
      status: "submitting",
      nonce: quote.nextPositionNonce,
      erEndpoint: prepared.erEndpoint,
      message: "Signing with your active session",
    });
    const instruction = openPositionInstruction(
      prepared.programId,
      {
        user: prepared.user,
        sessionSigner: prepared.sessionSigner.publicKey,
        sessionToken: prepared.sessionToken,
        protocolConfig: prepared.protocolConfig,
        market: prepared.market,
        userPositions: prepared.userPositions,
        poolTokenAccount: prepared.poolTokenAccount,
        derivedFeeAuthority: prepared.derivedFeeAuthority,
        feeTokenAccount: prepared.feeTokenAccount,
        userTokenAccount: prepared.userTokenAccount,
        payoutEscrowTokenAccount: prepared.payoutEscrowTokenAccount,
        collateralMint: prepared.collateralMint,
        priceUpdate: prepared.priceUpdate,
      },
      {
        nonce: quote.nextPositionNonce,
        taskSalt,
        direction,
        collateral,
        minEntryPrice: rawPrice - slippage,
        maxEntryPrice: rawPrice + slippage,
      },
    );

    report(onProgress, intent, "submitting", `Playing ${direction === "up" ? "Up" : "Down"} with your active session…`);

    const transaction = new Transaction({
      feePayer: prepared.sessionSigner.publicKey,
      blockhash: prepared.blockhash.blockhash,
      lastValidBlockHeight: prepared.blockhash.lastValidBlockHeight,
    }).add(instruction);
    transaction.sign(prepared.sessionSigner);
    const rawTransaction = transaction.serialize();
    debugTransaction("play:open-position", "submitting prepared transaction", {
      endpoint: safeRpcEndpoint(prepared.erConnection.rpcEndpoint),
      feePayer: prepared.sessionSigner.publicKey.toBase58(),
      blockhash: prepared.blockhash.blockhash,
      blockhashAgeMs: Date.now() - prepared.blockhash.updatedAt,
      minContextSlot: prepared.blockhash.minContextSlot,
      instructions: instructionSummary([instruction]),
    });
    const signature = await prepared.erConnection.sendRawTransaction(
      rawTransaction,
      {
        skipPreflight: true,
        maxRetries: 0,
        minContextSlot: prepared.blockhash.minContextSlot,
      },
    );
    const clickToSignatureMs = (globalThis.performance?.now() ?? Date.now()) - clickStartedAt;
    intent = updateIntent(intent, {
      status: "confirming",
      erSignature: signature,
      message: "Play sent · waiting for the position stream",
    });
    debugTransaction("play:open-position", "transaction submitted", {
      endpoint: safeRpcEndpoint(prepared.erConnection.rpcEndpoint),
      signature,
      clickToSignatureMs: Math.round(clickToSignatureMs * 10) / 10,
      latencyTargetMs: 200,
    }, clickToSignatureMs <= 200 ? "info" : "warn");
    report(onProgress, intent, "confirming", "Play sent · waiting for Your Plays…");
    return { intent, accepted: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "ER submission result is unknown";
    updateIntent(intent, { status: "ambiguous", message });
    throw cause;
  }
}
