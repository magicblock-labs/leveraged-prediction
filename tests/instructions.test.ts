import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  claimFallbackPayoutInstruction,
  delegateUserPositionsInstruction,
  deriveHydraCrank,
  instructionDiscriminators,
  openPositionInstruction,
} from "@/app/lib/live/instructions";
import { marketPda } from "@/app/lib/live/pdas";

const PROGRAM_ID = new PublicKey("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");

describe("final ABI write builders", () => {
  it("locks the generated instruction discriminators", () => {
    expect([...instructionDiscriminators.initializeUserPositions]).toEqual([6, 119, 238, 168, 19, 38, 23, 113]);
    expect([...instructionDiscriminators.delegateUserPositions]).toEqual([147, 104, 221, 210, 31, 52, 34, 53]);
    expect([...instructionDiscriminators.openPosition]).toEqual([135, 128, 47, 77, 15, 152, 240, 49]);
  });

  it("pins UserPositions delegation to the Market validator", () => {
    const user = new PublicKey("11111111111111111111111111111112");
    const positions = new PublicKey("11111111111111111111111111111113");
    const validator = new PublicKey("11111111111111111111111111111114");
    const instruction = delegateUserPositionsInstruction(PROGRAM_ID, user, positions, validator);
    expect(instruction.data).toHaveLength(40);
    expect(instruction.data.subarray(0, 8)).toEqual(Buffer.from(instructionDiscriminators.delegateUserPositions));
    expect(instruction.data.subarray(8)).toEqual(validator.toBuffer());
    expect(instruction.keys).toHaveLength(8);
  });

  it("builds the canonical seven-account fallback claim", () => {
    const keys = Array.from({ length: 6 }, (_, index) => new PublicKey(Uint8Array.from({ length: 32 }, () => index + 10)));
    const instruction = claimFallbackPayoutInstruction(PROGRAM_ID, {
      user: keys[0],
      protocolConfig: keys[1],
      userPositions: keys[2],
      payoutEscrowTokenAccount: keys[3],
      userTokenAccount: keys[4],
      collateralMint: keys[5],
    });
    expect(instruction.keys).toHaveLength(7);
    expect(instruction.data).toEqual(Buffer.from(instructionDiscriminators.claimFallbackPayout));
    expect(instruction.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(instruction.keys[3]).toMatchObject({ isSigner: false, isWritable: true });
    expect(instruction.keys[4]).toMatchObject({ isSigner: false, isWritable: true });
  });

  it("encodes open_position arguments and exact account count", () => {
    const keys = Array.from({ length: 13 }, (_, index) => new PublicKey(Uint8Array.from({ length: 32 }, () => index + 1)));
    const instruction = openPositionInstruction(
      PROGRAM_ID,
      {
        user: keys[0],
        taskPayer: keys[1],
        protocolConfig: keys[2],
        market: keys[3],
        userPositions: keys[4],
        poolTokenAccount: keys[5],
        derivedFeeAuthority: keys[6],
        feeTokenAccount: keys[7],
        userTokenAccount: keys[8],
        payoutEscrowTokenAccount: keys[9],
        collateralMint: keys[10],
        priceUpdate: keys[11],
        hydraCrank: keys[12],
      },
      {
        nonce: 17,
        taskSalt: Uint8Array.from({ length: 32 }, () => 9),
        direction: "up",
        collateral: 25_000_000n,
        minEntryPrice: 11_800_000_000_000n,
        maxEntryPrice: 11_900_000_000_000n,
      },
    );

    expect(instruction.keys).toHaveLength(18);
    expect(instruction.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(instruction.keys[1]).toMatchObject({ isSigner: true, isWritable: true });
    expect(instruction.data.subarray(0, 8)).toEqual(Buffer.from(instructionDiscriminators.openPosition));
    expect(instruction.data.readUInt32LE(8)).toBe(17);
    expect(instruction.data.subarray(12, 44)).toEqual(Buffer.alloc(32, 9));
    expect(instruction.data.readUInt8(44)).toBe(0);
    expect(instruction.data.readBigUInt64LE(45)).toBe(25_000_000n);
    expect(instruction.data.readBigInt64LE(53)).toBe(11_800_000_000_000n);
    expect(instruction.data.readBigInt64LE(61)).toBe(11_900_000_000_000n);
  });

  it("matches the Rust Hydra crank derivation vector", async () => {
    const market = marketPda(PROGRAM_ID, 1);
    const user = new PublicKey("11111111111111111111111111111112");
    const crank = await deriveHydraCrank(market, user, 7, Buffer.alloc(32, 1));
    expect(market.toBase58()).toBe("6ME7jFHJkk27zAM7hz2A3V1Y4EeTkcjyZxnekQLtn8V1");
    expect(crank.toBase58()).toBe("2Nq9YJidURjW9VEywc2gEvpsZqQfs1W7GQC97AY3qZCp");
  });

  it("rejects a zero task salt before a wallet can sign", () => {
    const key = new PublicKey("11111111111111111111111111111112");
    expect(() => openPositionInstruction(PROGRAM_ID, {
      user: key,
      taskPayer: key,
      protocolConfig: key,
      market: key,
      userPositions: key,
      poolTokenAccount: key,
      derivedFeeAuthority: key,
      feeTokenAccount: key,
      userTokenAccount: key,
      payoutEscrowTokenAccount: key,
      collateralMint: key,
      priceUpdate: key,
      hydraCrank: key,
    }, {
      nonce: 0,
      taskSalt: new Uint8Array(32),
      direction: "up",
      collateral: 1_000_000n,
      minEntryPrice: 1n,
      maxEntryPrice: 2n,
    })).toThrow(/nonzero 32-byte/);
  });
});
