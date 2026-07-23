import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  openPositionFlow,
  type PreparedOpenPositionContext,
  type TransactionProgress,
} from "@/app/lib/live/transaction-flow";
import type { StoredGameSession } from "@/app/lib/live/session-store";

function key(): PublicKey {
  return Keypair.generate().publicKey;
}

describe("prepared open-position submission", () => {
  it("sends immediately without account reads, simulation, or confirmation polling", async () => {
    const user = key();
    const sessionSigner = Keypair.generate();
    const programId = key();
    const sendRawTransaction = vi.fn().mockResolvedValue("fast-signature");
    const erConnection = {
      rpcEndpoint: "http://127.0.0.1:7799",
      sendRawTransaction,
    } as unknown as Connection;
    const prepared: PreparedOpenPositionContext = {
      user,
      programId,
      marketId: 1,
      erEndpoint: erConnection.rpcEndpoint,
      erConnection,
      sessionSigner,
      sessionToken: key(),
      protocolConfig: key(),
      market: key(),
      userPositions: key(),
      poolTokenAccount: key(),
      derivedFeeAuthority: key(),
      feeTokenAccount: key(),
      userTokenAccount: key(),
      payoutEscrowTokenAccount: key(),
      collateralMint: key(),
      priceUpdate: key(),
      blockhash: {
        blockhash: key().toBase58(),
        lastValidBlockHeight: 1_000,
        minContextSlot: 900,
        updatedAt: Date.now(),
      },
    };
    const session: StoredGameSession = {
      user: user.toBase58(),
      programId: programId.toBase58(),
      sessionToken: prepared.sessionToken.toBase58(),
      sessionSignerSecret: Array.from(sessionSigner.secretKey),
      allowanceMinor: "10000000",
      validUntil: Math.floor(Date.now() / 1_000) + 3_600,
      setupComplete: true,
    };
    const progress: TransactionProgress[] = [];

    const result = await openPositionFlow(
      user,
      "up",
      1,
      session,
      prepared,
      {
        rawPrice: "10000000000",
        nextPositionNonce: 7,
      },
      (update) => progress.push(update),
    );

    expect(result.accepted).toBe(true);
    expect(result.intent.erSignature).toBe("fast-signature");
    expect(result.intent.nonce).toBe(7);
    expect(progress.map(({ phase }) => phase)).toEqual([
      "submitting",
      "confirming",
    ]);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      {
        skipPreflight: true,
        maxRetries: 0,
        minContextSlot: 900,
      },
    );
  });
});
