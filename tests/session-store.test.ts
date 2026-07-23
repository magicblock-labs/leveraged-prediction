import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  sessionKeypair,
  sessionFeePayer,
  validateStoredSessionShape,
  type StoredGameSession,
} from "@/app/lib/live/session-store";

describe("game session storage", () => {
  it("accepts a wallet/program-bound session and restores its signer", () => {
    const user = PublicKey.unique();
    const programId = PublicKey.unique();
    const signer = Keypair.generate();
    const feePayer = Keypair.generate();
    const session: StoredGameSession = {
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: PublicKey.unique().toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      erFeePayerSecret: Array.from(feePayer.secretKey),
      allowanceMinor: "100000000",
      validUntil: 2_000_000_000,
      setupComplete: true,
    };

    expect(validateStoredSessionShape(session, user, programId)).toEqual(session);
    expect(sessionKeypair(session).publicKey.equals(signer.publicKey)).toBe(true);
    expect(sessionFeePayer(session).publicKey.equals(feePayer.publicKey)).toBe(true);
  });

  it("marks sessions saved by the previous app version for one-time fee-payer repair", () => {
    const user = PublicKey.unique();
    const programId = PublicKey.unique();
    const signer = Keypair.generate();
    const legacySession = {
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: PublicKey.unique().toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      allowanceMinor: "100000000",
      validUntil: 2_000_000_000,
    };

    expect(validateStoredSessionShape(legacySession, user, programId))
      .toMatchObject({ setupComplete: false, erFeePayerSecret: [] });
  });

  it("rejects sessions for another wallet and malformed signer material", () => {
    const user = PublicKey.unique();
    const programId = PublicKey.unique();
    const session = {
      user: PublicKey.unique().toBase58(),
      programId: programId.toBase58(),
      sessionToken: PublicKey.unique().toBase58(),
      sessionSignerSecret: [1, 2, 3],
      allowanceMinor: "1000000",
      validUntil: 2_000_000_000,
    };

    expect(validateStoredSessionShape(session, user, programId)).toBeNull();
  });

  it("rejects a malformed setup state", () => {
    const user = PublicKey.unique();
    const programId = PublicKey.unique();
    const signer = Keypair.generate();
    const session = {
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: PublicKey.unique().toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      allowanceMinor: "1000000",
      validUntil: 2_000_000_000,
      setupComplete: "yes",
    };

    expect(validateStoredSessionShape(session, user, programId)).toBeNull();
  });

  it("rejects malformed persisted ER fee-payer material", () => {
    const user = PublicKey.unique();
    const programId = PublicKey.unique();
    const signer = Keypair.generate();
    const session = {
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: PublicKey.unique().toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      erFeePayerSecret: [1, 2, 3],
      allowanceMinor: "1000000",
      validUntil: 2_000_000_000,
      setupComplete: true,
    };

    expect(validateStoredSessionShape(session, user, programId)).toBeNull();
  });
});
