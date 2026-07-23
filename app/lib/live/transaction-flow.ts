import "@/app/polyfills";
import {
  BN,
  type Wallet as AnchorWallet,
} from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  createDelegateInstruction,
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
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
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
import {
  browserSafeDepositSplTokensIx,
  browserSafeSetupAndDelegateShuttleIx,
} from "@/app/lib/live/espl-instructions";
import { decodeOraclePrice } from "@/app/lib/live/oracle";
import {
  getDelegationStatus,
  normalizeErEndpoint,
  type DelegationStatus,
} from "@/app/lib/live/router";
import { ORACLE_PROGRAM_ID } from "@/app/lib/live/config";
import {
  SESSION_DURATION_SECONDS,
  sessionFeePayer,
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
const ER_FEE_PAYER_LAMPORTS = 10_000_000;
const SESSION_TOKEN_PROGRAM_ID = GPLSESSION_PROGRAMS.devnet;

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

export interface SessionProgress {
  phase:
    | "creating"
    | "preparing-accounts"
    | "depositing"
    | "preparing-fee-payer"
    | "approving"
    | "ready";
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
  const feePayer = await ensureErFeePayer(context, signTransaction, onStatus);
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
      {
        feePayer: feePayer.publicKey,
        additionalSigners: [feePayer],
        label: "payout:claim",
      },
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

interface OnboardingCallbacks {
  status(
    phase: "initializing-positions" | "provisioning-payout" | "depositing-collateral",
    message: string,
  ): void;
  submitted(signature: string): void;
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

async function sendWithKeypairsAndConfirm(
  connection: Connection,
  feePayer: Keypair,
  instructions: TransactionInstruction[],
  signers: Signer[],
  onSubmitted?: (signature: string) => void,
  label = "session",
): Promise<string> {
  const endpoint = safeRpcEndpoint(connection.rpcEndpoint);
  const { context: blockhashContext, value: latest } =
    await connection.getLatestBlockhashAndContext("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  const uniqueSigners = new Map(
    [feePayer, ...signers].map((signer) => [signer.publicKey.toBase58(), signer]),
  );
  transaction.partialSign(...uniqueSigners.values());
  const simulation = await connection.simulateTransaction(transaction);
  debugTransaction(label, "prepared session-signed transaction", {
    endpoint,
    feePayer: feePayer.publicKey.toBase58(),
    signers: [...uniqueSigners.keys()],
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    minContextSlot: blockhashContext.slot,
    instructions: instructionSummary(instructions),
  });
  debugTransaction(label, "simulation completed", {
    endpoint,
    error: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs,
  }, simulation.value.err ? "error" : "info");
  if (simulation.value.err) {
    throw new Error(
      `Session transaction simulation failed during ${label}: ${JSON.stringify(simulation.value.err)}. Open the browser console for runtime logs.`,
    );
  }
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      minContextSlot: blockhashContext.slot,
    });
  } catch (cause) {
    debugTransaction(
      label,
      "session-signed RPC submission failed",
      {
        endpoint,
        error: cause instanceof Error ? cause.message : String(cause),
        simulationLogs: simulation.value.logs,
      },
      "error",
    );
    throw cause;
  }
  debugTransaction(label, "transaction submitted", {
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
    transaction.serialize(),
  );
}

async function ensureErFeePayer(
  context: LiveWriteContext,
  signTransaction: SignTransaction,
  onStatus: (message: string) => void,
  onSubmitted?: (signature: string) => void,
  storedFeePayer?: Keypair,
): Promise<Keypair> {
  const feePayer = storedFeePayer ?? Keypair.generate();
  const info = await context.baseConnection.getAccountInfo(feePayer.publicKey, "confirmed");
  if (info) {
    if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
      await waitForRoute(context.routerEndpoint, feePayer.publicKey, context.erEndpoint);
      return feePayer;
    }
    if (!info.owner.equals(SystemProgram.programId)) {
      throw new Error("Stored session fee payer has an unexpected base-layer owner");
    }
  }

  onStatus("Preparing a fast fee account for this arena…");
  const fundingShortfall = Math.max(
    0,
    ER_FEE_PAYER_LAMPORTS - (info?.lamports ?? 0),
  );
  const instructions: TransactionInstruction[] = [];
  if (fundingShortfall > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: context.user,
        toPubkey: feePayer.publicKey,
        lamports: fundingShortfall,
      }),
    );
  }
  instructions.push(
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
  );
  await sendAndConfirm(
    context.baseConnection,
    context.user,
    signTransaction,
    instructions,
    onSubmitted,
    {
      additionalSigners: [feePayer],
      label: "setup:er-fee-payer",
    },
  );
  await waitForRoute(context.routerEndpoint, feePayer.publicKey, context.erEndpoint);
  return feePayer;
}

async function validateSessionFeePayerInContext(
  context: LiveWriteContext,
  session: StoredGameSession,
): Promise<Keypair> {
  const feePayer = sessionFeePayer(session);
  const info = await context.baseConnection.getAccountInfo(
    feePayer.publicKey,
    "confirmed",
  );
  if (!info?.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("Session fee payer is not delegated");
  }
  await waitForRoute(
    context.routerEndpoint,
    feePayer.publicKey,
    context.erEndpoint,
  );
  return feePayer;
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
  await validateSessionFeePayerInContext(context, session);
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
    throw new Error("Session spending limit must be between 1 and 1,000 USDC");
  }
  const allowanceMinor = BigInt(Math.round(allowanceUsd * 1_000_000));
  const context = await loadWriteContext(user);
  let session: StoredGameSession;
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
      erFeePayerSecret:
        options.existingSession.erFeePayerSecret.length === 64
          ? options.existingSession.erFeePayerSecret
          : Array.from(Keypair.generate().secretKey),
      allowanceMinor: allowanceMinor.toString(),
      setupComplete: false,
    };
    options.onSessionAvailable?.(session);
    onProgress({
      phase: "preparing-accounts",
      message: "Session found. Continuing the remaining setup…",
    });
  } else {
    const signer = Keypair.generate();
    const feePayer = Keypair.generate();
    const chainSlot = await context.baseConnection.getSlot("confirmed");
    const chainTime = await context.baseConnection.getBlockTime(chainSlot);
    const validUntil = (chainTime ?? Math.floor(Date.now() / 1_000)) + SESSION_DURATION_SECONDS;
    const sessionToken = sessionTokenPda(context.programId, signer.publicKey, user);
    const manager = new SessionTokenManager(
      anchorBuildWallet(user),
      context.baseConnection,
    );

    onProgress({ phase: "creating", message: "Creating your one-hour play session…" });
    const createTransaction = await manager.program.methods
      .createSessionV2(false, new BN(validUntil), new BN(0))
      .accounts({
        targetProgram: context.programId,
        sessionSigner: signer.publicKey,
        feePayer: user,
        authority: user,
      })
      .transaction();
    await sendAndConfirm(
      context.baseConnection,
      user,
      signTransaction,
      createTransaction.instructions,
      undefined,
      {
        additionalSigners: [signer],
        label: "session:create-token",
      },
    );
    session = {
      user: user.toBase58(),
      programId: context.programId.toBase58(),
      sessionToken: sessionToken.toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      erFeePayerSecret: Array.from(feePayer.secretKey),
      allowanceMinor: allowanceMinor.toString(),
      validUntil,
      setupComplete: false,
    };
    options.onSessionAvailable?.(session);
    onProgress({
      phase: "preparing-accounts",
      message: "Session created. Preparing your play accounts…",
    });
  }

  const callbacks: OnboardingCallbacks = {
    status: (phase, message) => {
      onProgress({
        phase: phase === "depositing-collateral" ? "depositing" : "preparing-accounts",
        message,
      });
    },
    submitted: () => undefined,
  };
  await ensureUserPositions(context, signTransaction, callbacks);
  await ensureFallbackBalance(context, signTransaction, callbacks);
  const collateral = await ensureCollateralBalance(
    context,
    allowanceMinor,
    signTransaction,
    callbacks,
  );
  const feePayer = await ensureErFeePayer(
    context,
    signTransaction,
    (message) => onProgress({ phase: "preparing-fee-payer", message }),
    undefined,
    sessionFeePayer(session),
  );
  onProgress({
    phase: "approving",
    message: `Approving a ${allowanceUsd.toFixed(2)} USDC session spending limit…`,
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
    {
      feePayer: feePayer.publicKey,
      additionalSigners: [feePayer],
      label: "session:approve-collateral",
    },
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

async function ensureUserPositions(
  context: LiveWriteContext,
  signTransaction: SignTransaction,
  callbacks: OnboardingCallbacks,
): Promise<void> {
  const info = await context.baseConnection.getAccountInfo(context.userPositions, "confirmed");
  if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
    await waitForRoute(context.routerEndpoint, context.userPositions, context.erEndpoint);
    return;
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
  await sendAndConfirm(
    context.baseConnection,
    context.user,
    signTransaction,
    instructions,
    callbacks.submitted,
    { label: "setup:user-positions" },
  );
  await waitForRoute(context.routerEndpoint, context.userPositions, context.erEndpoint);
}

async function ensureFallbackBalance(
  context: LiveWriteContext,
  signTransaction: SignTransaction,
  callbacks: OnboardingCallbacks,
): Promise<{ eata: PublicKey; ata: PublicKey }> {
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
  if (instructions.length > 0) {
    await sendAndConfirm(
      context.baseConnection,
      context.user,
      signTransaction,
      instructions,
      callbacks.submitted,
      { label: "setup:fallback-payout" },
    );
  }
  await waitForTokenRoute(
    context.routerEndpoint,
    eata,
    ata,
    context.erEndpoint,
  );
  await waitForTokenAmount(context.erConnection, ata, 0n);
  const account = await getAccount(context.erConnection, ata, "confirmed");
  if (!account.owner.equals(context.userPositions) || !account.mint.equals(context.collateralMint)) {
    throw new Error("Fallback payout ATA owner or mint mismatch on the ER");
  }
  return { eata, ata };
}

async function ensureCollateralBalance(
  context: LiveWriteContext,
  amount: bigint,
  signTransaction: SignTransaction,
  callbacks: OnboardingCallbacks,
): Promise<{ eata: PublicKey; ata: PublicKey }> {
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
  if (erAmount >= amount) return { eata, ata };

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

  await sendAndConfirm(
    context.baseConnection,
    context.user,
    signTransaction,
    instructions,
    callbacks.submitted,
    { label: "setup:collateral" },
  );
  await waitForTokenRoute(
    context.routerEndpoint,
    eata,
    ata,
    context.erEndpoint,
  );
  await waitForTokenAmount(context.erConnection, ata, amount);
  return { eata, ata };
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
  session: StoredGameSession,
  onProgress: ProgressHandler,
): Promise<OpenFlowResult> {
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1_000) {
    throw new Error("Play amount must be between 1 and 1,000 USDC");
  }
  const collateral = BigInt(Math.round(amountUsd * 1_000_000));
  if (collateral > MAX_POSITION_MINOR) throw new Error("Play amount exceeds the contract maximum");
  const sessionSigner = sessionKeypair(session);
  if (
    session.user !== user.toBase58() ||
    !session.setupComplete ||
    session.validUntil <= Math.floor(Date.now() / 1_000)
  ) {
    throw new Error("A valid session is required before playing");
  }
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
  if (session.programId !== context.programId.toBase58()) {
    throw new Error("Session targets a different program");
  }

  try {
    const [collateralEata] = deriveEphemeralAta(
      context.user,
      context.collateralMint,
    );
    const collateralBalance = {
      eata: collateralEata,
      ata: getAssociatedTokenAddressSync(
        context.collateralMint,
        context.user,
      ),
    };
    const [fallbackEata] = deriveEphemeralAta(
      context.userPositions,
      context.collateralMint,
    );
    const fallback = {
      eata: fallbackEata,
      ata: getAssociatedTokenAddressSync(
        context.collateralMint,
        context.userPositions,
        true,
      ),
    };
    const feePayer = await validateSessionFeePayerInContext(context, session);

    report(onProgress, intent, "verifying-route", "Verifying every play account is in the same arena…");
    const poolTokenAccount = getAssociatedTokenAddressSync(context.collateralMint, context.market, true);
    const feeTokenAccount = getAssociatedTokenAddressSync(context.collateralMint, context.feeAuthority, true);
    const [poolEphemeralTokenAccount] = deriveEphemeralAta(
      context.market,
      context.collateralMint,
    );
    const [feeEphemeralTokenAccount] = deriveEphemeralAta(
      context.feeAuthority,
      context.collateralMint,
    );
    await Promise.all([
      assertRouteSet(context, [
        context.market,
        context.userPositions,
      ]),
      waitForTokenRoute(
        context.routerEndpoint,
        collateralBalance.eata,
        collateralBalance.ata,
        context.erEndpoint,
      ),
      waitForTokenRoute(
        context.routerEndpoint,
        fallback.eata,
        fallback.ata,
        context.erEndpoint,
      ),
      waitForTokenRoute(
        context.routerEndpoint,
        poolEphemeralTokenAccount,
        poolTokenAccount,
        context.erEndpoint,
      ),
      waitForTokenRoute(
        context.routerEndpoint,
        feeEphemeralTokenAccount,
        feeTokenAccount,
        context.erEndpoint,
      ),
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
    // Pricing feeds are shared, unpinned clones. Validate the feed on the Market ER
    // instead of asking the router to resolve its sentinel validator as one region.
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
    if (
      !userToken.delegate?.equals(sessionSigner.publicKey) ||
      userToken.delegatedAmount < collateral
    ) {
      throw new Error("Session spending allowance is exhausted or no longer active");
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
        sessionSigner: sessionSigner.publicKey,
        sessionToken: new PublicKey(session.sessionToken),
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

    intent = updateIntent(intent, { status: "submitting", message: "Signing with your active session" });
    report(onProgress, intent, "submitting", `Playing ${direction === "up" ? "Up" : "Down"} with your active session…`);
    let signature: string;
    try {
      signature = await sendWithKeypairsAndConfirm(
        context.erConnection,
        feePayer,
        [instruction],
        [sessionSigner],
        (submittedSignature) => {
          intent = updateIntent(intent, {
            status: "confirming",
            erSignature: submittedSignature,
          });
          report(onProgress, intent, "confirming", "Play sent. Confirming it in Your Plays…");
        },
        "play:open-position",
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
