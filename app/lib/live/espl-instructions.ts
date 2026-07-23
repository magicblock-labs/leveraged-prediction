import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  deriveRentPda,
  deriveVault,
  deriveVaultAta,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

const U64_MAX = (1n << 64n) - 1n;

function writeU32Le(bytes: Uint8Array, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("value must fit in u32");
  }
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = Math.floor(value / (2 ** (index * 8))) & 0xff;
  }
}

function writeU64Le(bytes: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new Error("value must fit in u64");
  }
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

export function browserSafeDepositSplTokensIx(
  ephemeralAta: PublicKey,
  vault: PublicKey,
  mint: PublicKey,
  sourceAta: PublicKey,
  vaultAta: PublicKey,
  owner: PublicKey,
  amount: bigint,
  tokenProgram = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const bytes = new Uint8Array(9);
  bytes[0] = 2;
  writeU64Le(bytes, 1, amount);
  return new TransactionInstruction({
    programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: ephemeralAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(bytes),
  });
}

export function browserSafeSetupAndDelegateShuttleIx(
  payer: PublicKey,
  shuttleEphemeralAta: PublicKey,
  shuttleAta: PublicKey,
  owner: PublicKey,
  sourceAta: PublicKey,
  destinationAta: PublicKey,
  shuttleWalletAta: PublicKey,
  mint: PublicKey,
  shuttleId: number,
  amount: bigint,
  validator?: PublicKey,
  tokenProgram = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const bytes = new Uint8Array(validator ? 45 : 13);
  bytes[0] = 24;
  writeU32Le(bytes, 1, shuttleId);
  writeU64Le(bytes, 5, amount);
  if (validator) bytes.set(validator.toBytes(), 13);

  const [rentPda] = deriveRentPda();
  const [vault] = deriveVault(mint);
  const vaultAta = deriveVaultAta(mint, vault, tokenProgram);
  return new TransactionInstruction({
    programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: rentPda, isSigner: false, isWritable: true },
      { pubkey: shuttleEphemeralAta, isSigner: false, isWritable: true },
      { pubkey: shuttleAta, isSigner: false, isWritable: true },
      { pubkey: shuttleWalletAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      {
        pubkey: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
          shuttleAta,
          EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationRecordPdaFromDelegatedAccount(shuttleAta),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationMetadataPdaFromDelegatedAccount(shuttleAta),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(bytes),
  });
}
