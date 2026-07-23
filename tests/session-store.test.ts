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
    };

    expect(validateStoredSessionShape(session, user, programId)).toEqual(session);
    expect(sessionKeypair(session).publicKey.equals(signer.publicKey)).toBe(true);
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
});
