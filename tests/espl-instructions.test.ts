import { Buffer } from "buffer";
import {
  depositSplTokensIx,
  deriveEphemeralAta,
  deriveShuttleAta,
  deriveShuttleEphemeralAta,
  deriveShuttleWalletAta,
  deriveVault,
  deriveVaultAta,
  setupAndDelegateShuttleEphemeralAtaWithMergeIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  browserSafeDepositSplTokensIx,
  browserSafeSetupAndDelegateShuttleIx,
} from "@/app/lib/live/espl-instructions";

function expectSameInstruction(
  actual: ReturnType<typeof browserSafeDepositSplTokensIx>,
  expected: ReturnType<typeof depositSplTokensIx>,
): void {
  expect(actual.programId.equals(expected.programId)).toBe(true);
  expect(actual.data).toEqual(expected.data);
  expect(actual.keys).toEqual(expected.keys);
}

describe("browser-safe eSPL instruction builders", () => {
  it("matches the pinned SDK deposit instruction exactly", () => {
    const owner = PublicKey.unique();
    const mint = PublicKey.unique();
    const sourceAta = PublicKey.unique();
    const [ephemeralAta] = deriveEphemeralAta(owner, mint);
    const [vault] = deriveVault(mint);
    const vaultAta = deriveVaultAta(mint, vault);
    const amount = 25_000_000n;

    expectSameInstruction(
      browserSafeDepositSplTokensIx(
        ephemeralAta,
        vault,
        mint,
        sourceAta,
        vaultAta,
        owner,
        amount,
      ),
      depositSplTokensIx(
        ephemeralAta,
        vault,
        mint,
        sourceAta,
        vaultAta,
        owner,
        amount,
      ),
    );
  });

  it("matches the pinned SDK delegated-shuttle instruction exactly", () => {
    const payer = PublicKey.unique();
    const owner = PublicKey.unique();
    const mint = PublicKey.unique();
    const sourceAta = PublicKey.unique();
    const destinationAta = PublicKey.unique();
    const validator = PublicKey.unique();
    const shuttleId = 42;
    const [shuttleEphemeralAta] = deriveShuttleEphemeralAta(owner, mint, shuttleId);
    const [shuttleAta] = deriveShuttleAta(shuttleEphemeralAta, mint);
    const shuttleWalletAta = deriveShuttleWalletAta(mint, shuttleEphemeralAta);
    const amount = 12_345_678n;

    expectSameInstruction(
      browserSafeSetupAndDelegateShuttleIx(
        payer,
        shuttleEphemeralAta,
        shuttleAta,
        owner,
        sourceAta,
        destinationAta,
        shuttleWalletAta,
        mint,
        shuttleId,
        amount,
        validator,
      ),
      setupAndDelegateShuttleEphemeralAtaWithMergeIx(
        payer,
        shuttleEphemeralAta,
        shuttleAta,
        owner,
        sourceAta,
        destinationAta,
        shuttleWalletAta,
        mint,
        shuttleId,
        amount,
        validator,
      ),
    );
  });

  it("encodes deposits when global Buffer alloc returns a plain Uint8Array", () => {
    const original = globalThis.Buffer;
    globalThis.Buffer = {
      alloc: (size: number) => new Uint8Array(size),
      concat: original.concat.bind(original),
      from: original.from.bind(original),
    } as unknown as typeof Buffer;
    try {
      const keys = Array.from({ length: 6 }, () => PublicKey.unique());
      expect(() => depositSplTokensIx(
        keys[0],
        keys[1],
        keys[2],
        keys[3],
        keys[4],
        keys[5],
        25_000_000n,
      )).toThrow("data.writeBigUInt64LE is not a function");

      const instruction = browserSafeDepositSplTokensIx(
        keys[0],
        keys[1],
        keys[2],
        keys[3],
        keys[4],
        keys[5],
        25_000_000n,
      );
      expect([...instruction.data]).toEqual([
        2, 64, 120, 125, 1, 0, 0, 0, 0,
      ]);
    } finally {
      globalThis.Buffer = original;
    }
  });
});
