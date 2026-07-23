import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { validateWalletSignedTransaction } from "@/app/lib/live/transaction-flow";

function baseTransaction(lamports = 1): {
  transaction: Transaction;
  payer: Keypair;
} {
  const payer = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports,
    }),
  );
  return { transaction, payer };
}

describe("wallet transaction validation", () => {
  it("accepts a signature-only wallet response", () => {
    const { transaction, payer } = baseTransaction();
    const signed = Transaction.from(
      transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
    );
    signed.partialSign(payer);

    expect(validateWalletSignedTransaction(transaction, signed, 0)).toEqual({
      modified: false,
    });
  });

  it("accepts bounded Phantom-style compute budget instructions", () => {
    const { transaction, payer } = baseTransaction();
    const signed = new Transaction({
      feePayer: transaction.feePayer!,
      blockhash: transaction.recentBlockhash!,
      lastValidBlockHeight: transaction.lastValidBlockHeight!,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000n }),
      ...transaction.instructions,
    );
    signed.partialSign(payer);

    expect(validateWalletSignedTransaction(transaction, signed, 0)).toEqual({
      modified: true,
      computeUnitLimit: 300_000,
      computeUnitPriceMicroLamports: "100000",
    });
  });

  it("rejects changes to application instructions", () => {
    const expected = baseTransaction(1).transaction;
    const changed = baseTransaction(2).transaction;
    changed.feePayer = expected.feePayer;
    changed.recentBlockhash = expected.recentBlockhash;

    expect(() =>
      validateWalletSignedTransaction(expected, changed, 0),
    ).toThrow("non-compute-budget instruction");
  });

  it("rejects an excessive compute-unit price", () => {
    const { transaction } = baseTransaction();
    const signed = new Transaction({
      feePayer: transaction.feePayer!,
      blockhash: transaction.recentBlockhash!,
      lastValidBlockHeight: transaction.lastValidBlockHeight!,
    }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_001n }),
      ...transaction.instructions,
    );

    expect(() =>
      validateWalletSignedTransaction(transaction, signed, 0),
    ).toThrow("compute-unit price is outside the safe range");
  });

  it("rejects mutations after an additional signer has signed", () => {
    const { transaction } = baseTransaction();
    const signed = new Transaction({
      feePayer: transaction.feePayer!,
      blockhash: transaction.recentBlockhash!,
      lastValidBlockHeight: transaction.lastValidBlockHeight!,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ...transaction.instructions,
    );

    expect(() =>
      validateWalletSignedTransaction(transaction, signed, 1),
    ).toThrow("already had an additional signature");
  });
});
