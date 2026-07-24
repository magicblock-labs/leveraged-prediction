import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  claimFallbackPayoutInstruction,
  crankSignerPda,
  delegateUserLiquidityInstruction,
  delegateUserPositionsInstruction,
  depositLiquidityInstruction,
  executeWithdrawalInstruction,
  initializeUserLiquidityInstruction,
  instructionDiscriminators,
  openPositionInstruction,
  requestWithdrawalInstruction,
} from "@/app/lib/live/instructions";

const PROGRAM_ID = new PublicKey("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");

describe("final ABI write builders", () => {
  it("locks the generated instruction discriminators", () => {
    expect([...instructionDiscriminators.initializeUserPositions]).toEqual([6, 119, 238, 168, 19, 38, 23, 113]);
    expect([...instructionDiscriminators.initializeUserLiquidity]).toEqual([250, 167, 58, 109, 173, 95, 219, 138]);
    expect([...instructionDiscriminators.delegateUserPositions]).toEqual([147, 104, 221, 210, 31, 52, 34, 53]);
    expect([...instructionDiscriminators.delegateUserLiquidity]).toEqual([213, 222, 197, 230, 173, 223, 102, 167]);
    expect([...instructionDiscriminators.depositLiquidity]).toEqual([245, 99, 59, 25, 151, 71, 233, 249]);
    expect([...instructionDiscriminators.requestWithdrawal]).toEqual([251, 85, 121, 205, 56, 201, 12, 177]);
    expect([...instructionDiscriminators.executeWithdrawal]).toEqual([113, 121, 203, 232, 137, 139, 248, 249]);
    expect([...instructionDiscriminators.openPosition]).toEqual([135, 128, 47, 77, 15, 152, 240, 49]);
  });

  it("builds liquidity account setup against the canonical PDA", () => {
    const user = new PublicKey("11111111111111111111111111111112");
    const liquidity = new PublicKey("11111111111111111111111111111113");
    const validator = new PublicKey("11111111111111111111111111111114");
    const initialize = initializeUserLiquidityInstruction(PROGRAM_ID, user, liquidity);
    const delegate = delegateUserLiquidityInstruction(
      PROGRAM_ID,
      user,
      liquidity,
      validator,
    );

    expect(initialize.keys).toHaveLength(3);
    expect(initialize.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(initialize.data).toEqual(Buffer.from(instructionDiscriminators.initializeUserLiquidity));
    expect(delegate.keys).toHaveLength(8);
    expect(delegate.keys[4].pubkey.equals(liquidity)).toBe(true);
    expect(delegate.data.subarray(8)).toEqual(validator.toBuffer());
  });

  it("encodes deposit and bundled withdrawal instructions", () => {
    const keys = Array.from(
      { length: 7 },
      (_, index) =>
        new PublicKey(Uint8Array.from({ length: 32 }, () => index + 1)),
    );
    const accounts = {
      user: keys[0],
      protocolConfig: keys[1],
      market: keys[2],
      userLiquidity: keys[3],
      poolTokenAccount: keys[4],
      userTokenAccount: keys[5],
      collateralMint: keys[6],
    };
    const shares = (1n << 80n) + 17n;
    const deposit = depositLiquidityInstruction(
      PROGRAM_ID,
      accounts,
      25_000_000n,
      shares,
    );
    const request = requestWithdrawalInstruction(
      PROGRAM_ID,
      accounts,
      shares,
      24_875_000n,
    );
    const execute = executeWithdrawalInstruction(PROGRAM_ID, accounts);

    expect(deposit.keys).toHaveLength(8);
    expect(deposit.data.readBigUInt64LE(8)).toBe(25_000_000n);
    expect(deposit.data.readBigUInt64LE(16)).toBe(17n);
    expect(deposit.data.readBigUInt64LE(24)).toBe(1n << 16n);
    expect(request.keys).toHaveLength(3);
    expect(request.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(request.data.readBigUInt64LE(8)).toBe(17n);
    expect(request.data.readBigUInt64LE(16)).toBe(1n << 16n);
    expect(request.data.readBigUInt64LE(24)).toBe(24_875_000n);
    expect(execute.keys).toHaveLength(8);
    expect(execute.keys[0]).toMatchObject({ isSigner: false, isWritable: false });
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
        sessionSigner: keys[1],
        sessionToken: keys[2],
        protocolConfig: keys[3],
        market: keys[4],
        userPositions: keys[5],
        poolTokenAccount: keys[6],
        derivedFeeAuthority: keys[7],
        feeTokenAccount: keys[8],
        userTokenAccount: keys[9],
        payoutEscrowTokenAccount: keys[10],
        collateralMint: keys[11],
        priceUpdate: keys[12],
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

    expect(instruction.keys).toHaveLength(16);
    expect(instruction.keys[0]).toMatchObject({ isSigner: false, isWritable: false });
    expect(instruction.keys[1]).toMatchObject({ isSigner: true, isWritable: false });
    expect(instruction.keys[7]).toMatchObject({ isSigner: false, isWritable: true });
    expect(instruction.keys[9]).toMatchObject({ isSigner: false, isWritable: true });
    expect(instruction.keys[13]).toMatchObject({
      pubkey: crankSignerPda(keys[4]),
      isSigner: false,
      isWritable: false,
    });
    expect(instruction.keys[15]).toMatchObject({ pubkey: keys[2], isSigner: false, isWritable: false });
    expect(instruction.data.subarray(0, 8)).toEqual(Buffer.from(instructionDiscriminators.openPosition));
    expect(instruction.data.readUInt32LE(8)).toBe(17);
    expect(instruction.data.subarray(12, 44)).toEqual(Buffer.alloc(32, 9));
    expect(instruction.data.readUInt8(44)).toBe(0);
    expect(instruction.data.readBigUInt64LE(45)).toBe(25_000_000n);
    expect(instruction.data.readBigInt64LE(53)).toBe(11_800_000_000_000n);
    expect(instruction.data.readBigInt64LE(61)).toBe(11_900_000_000_000n);
  });

  it("derives the canonical MagicBlock scheduler signer", () => {
    const market = new PublicKey("6ME7jFHJkk27zAM7hz2A3V1Y4EeTkcjyZxnekQLtn8V1");
    expect(crankSignerPda(market).toBase58()).toBe("BLfDLg2Sv4wrbRaNb6sZv6wWvrg1BpaDArW5FaoricW1");
  });

  it("rejects a zero task salt before a wallet can sign", () => {
    const key = new PublicKey("11111111111111111111111111111112");
    expect(() => openPositionInstruction(PROGRAM_ID, {
      user: key,
      sessionSigner: key,
      sessionToken: key,
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
