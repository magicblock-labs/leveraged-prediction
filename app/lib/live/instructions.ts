import {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Direction } from "@/app/lib/domain";
import { delegationBufferPda } from "@/app/lib/live/pdas";
import { Buffer } from "buffer";

const CRANK_PROGRAM_ID = new PublicKey(
  "Crank11111111111111111111111111111111111111",
);
export function crankSignerPda(taskAuthority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("crank-executor"), taskAuthority.toBuffer()],
    CRANK_PROGRAM_ID,
  )[0];
}

const INITIALIZE_USER_POSITIONS_DISCRIMINATOR = Uint8Array.from([
  6, 119, 238, 168, 19, 38, 23, 113,
]);
const DELEGATE_USER_POSITIONS_DISCRIMINATOR = Uint8Array.from([
  147, 104, 221, 210, 31, 52, 34, 53,
]);
const OPEN_POSITION_DISCRIMINATOR = Uint8Array.from([
  135, 128, 47, 77, 15, 152, 240, 49,
]);
const CLAIM_FALLBACK_PAYOUT_DISCRIMINATOR = Uint8Array.from([
  215, 117, 24, 176, 107, 179, 59, 212,
]);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

export function initializeUserPositionsInstruction(
  programId: PublicKey,
  user: PublicKey,
  userPositions: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    data: Buffer.from(INITIALIZE_USER_POSITIONS_DISCRIMINATOR),
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userPositions, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function delegateUserPositionsInstruction(
  programId: PublicKey,
  user: PublicKey,
  userPositions: PublicKey,
  validator: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    data: Buffer.from(
      concatBytes(DELEGATE_USER_POSITIONS_DISCRIMINATOR, validator.toBytes()),
    ),
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      {
        pubkey: delegationBufferPda(programId, userPositions),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationRecordPdaFromDelegatedAccount(userPositions),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationMetadataPdaFromDelegatedAccount(userPositions),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: userPositions, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export interface OpenPositionAccounts {
  user: PublicKey;
  sessionSigner: PublicKey;
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
}

export function claimFallbackPayoutInstruction(
  programId: PublicKey,
  accounts: {
    user: PublicKey;
    protocolConfig: PublicKey;
    userPositions: PublicKey;
    payoutEscrowTokenAccount: PublicKey;
    userTokenAccount: PublicKey;
    collateralMint: PublicKey;
  },
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    data: Buffer.from(CLAIM_FALLBACK_PAYOUT_DISCRIMINATOR),
    keys: [
      { pubkey: accounts.user, isSigner: true, isWritable: false },
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.userPositions, isSigner: false, isWritable: false },
      { pubkey: accounts.payoutEscrowTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.collateralMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export interface OpenPositionArguments {
  nonce: number;
  taskSalt: Uint8Array;
  direction: Direction;
  collateral: bigint;
  minEntryPrice: bigint;
  maxEntryPrice: bigint;
}

export function openPositionInstruction(
  programId: PublicKey,
  accounts: OpenPositionAccounts,
  args: OpenPositionArguments,
): TransactionInstruction {
  if (args.taskSalt.length !== 32 || args.taskSalt.every((value) => value === 0)) {
    throw new Error("taskSalt must be a nonzero 32-byte value");
  }
  const data = concatBytes(
    OPEN_POSITION_DISCRIMINATOR,
    u32(args.nonce),
    args.taskSalt,
    Uint8Array.of(args.direction === "up" ? 0 : 1),
    u64(args.collateral),
    i64(args.minEntryPrice),
    i64(args.maxEntryPrice),
  );
  return new TransactionInstruction({
    programId,
    data: Buffer.from(data),
    keys: [
      { pubkey: accounts.user, isSigner: false, isWritable: false },
      { pubkey: accounts.sessionSigner, isSigner: true, isWritable: false },
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.market, isSigner: false, isWritable: true },
      { pubkey: accounts.userPositions, isSigner: false, isWritable: true },
      { pubkey: accounts.poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.derivedFeeAuthority, isSigner: false, isWritable: false },
      { pubkey: accounts.feeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.payoutEscrowTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.collateralMint, isSigner: false, isWritable: false },
      { pubkey: accounts.priceUpdate, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: crankSignerPda(accounts.market), isSigner: false, isWritable: false },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: accounts.sessionToken, isSigner: false, isWritable: false },
    ],
  });
}

export const instructionDiscriminators = {
  initializeUserPositions: INITIALIZE_USER_POSITIONS_DISCRIMINATOR,
  delegateUserPositions: DELEGATE_USER_POSITIONS_DISCRIMINATOR,
  openPosition: OPEN_POSITION_DISCRIMINATOR,
  claimFallbackPayout: CLAIM_FALLBACK_PAYOUT_DISCRIMINATOR,
};
