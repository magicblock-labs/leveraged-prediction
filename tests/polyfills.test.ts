import { Buffer } from "buffer";
import {
  depositSplTokensIx,
  deriveEphemeralAta,
  deriveVault,
  deriveVaultAta,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { installBrowserBuffer } from "@/app/polyfills";

describe("browser polyfills", () => {
  it("installs the Buffer implementation required by the eSPL SDK", () => {
    const original = globalThis.Buffer;
    globalThis.Buffer = {
      alloc: (size: number) => new Uint8Array(size),
    } as unknown as typeof Buffer;

    installBrowserBuffer();

    expect(globalThis.Buffer).toBe(Buffer);
    expect(typeof globalThis.Buffer.alloc(9).writeBigUInt64LE).toBe("function");
    globalThis.Buffer = original;
  });

  it("encodes an eSPL deposit amount with the browser Buffer", () => {
    installBrowserBuffer();
    const owner = new PublicKey("11111111111111111111111111111112");
    const mint = new PublicKey("11111111111111111111111111111113");
    const source = new PublicKey("11111111111111111111111111111114");
    const [ephemeralAta] = deriveEphemeralAta(owner, mint);
    const [vault] = deriveVault(mint);
    const vaultAta = deriveVaultAta(mint, vault);

    const instruction = depositSplTokensIx(
      ephemeralAta,
      vault,
      mint,
      source,
      vaultAta,
      owner,
      25_000_000n,
    );

    expect(instruction.data[0]).toBe(2);
    expect(instruction.data.readBigUInt64LE(1)).toBe(25_000_000n);
  });
});
