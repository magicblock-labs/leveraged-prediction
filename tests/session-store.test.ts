import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  sessionKeypair,
  validateStoredSessionShape,
  type StoredGameSession,
} from "@/app/lib/live/session-store";

describe("game session storage", () => {
  it("accepts a wallet/program-bound session and restores its signer", () => {
    const user = PublicKey.unique();
    const programId = PublicKey.unique();
    const signer = Keypair.generate();
    const session: StoredGameSession = {
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: PublicKey.unique().toBase58(),
      sessionSignerSecret: Array.from(signer.secretKey),
      allowanceMinor: "100000000",
      validUntil: 2_000_000_000,
      setupComplete: true,
    };

    expect(validateStoredSessionShape(session, user, programId)).toEqual(session);
    expect(sessionKeypair(session).publicKey.equals(signer.publicKey)).toBe(true);
  });

  it("marks sessions saved before setup completion tracking as incomplete", () => {
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
      .toMatchObject({ setupComplete: false });
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

  it("drops the obsolete persisted ER fee-payer material", () => {
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

    expect(validateStoredSessionShape(session, user, programId)).toEqual({
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: session.sessionToken,
      sessionSignerSecret: session.sessionSignerSecret,
      allowanceMinor: "1000000",
      validUntil: 2_000_000_000,
      setupComplete: true,
    });
  });
});
