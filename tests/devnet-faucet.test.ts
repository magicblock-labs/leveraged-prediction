import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  decodeDevnetFaucetAuthorityBase64,
  isTrustedDevnetRpc,
  requiredTopUp,
} from "@/app/lib/live/devnet-faucet";

describe("devnet faucet policy", () => {
  it("allows only the explicit trusted Solana devnet RPCs", () => {
    expect(isTrustedDevnetRpc("https://rpc.magicblock.app/devnet")).toBe(true);
    expect(isTrustedDevnetRpc("https://api.devnet.solana.com/")).toBe(true);
    expect(isTrustedDevnetRpc("https://rpc.magicblock.app/mainnet")).toBe(false);
    expect(isTrustedDevnetRpc("https://rpc.magicblock.app/devnet/extra")).toBe(false);
    expect(isTrustedDevnetRpc("https://rpc.magicblock.app.evil.test/devnet")).toBe(false);
    expect(isTrustedDevnetRpc("http://rpc.magicblock.app/devnet")).toBe(false);
  });

  it("tops up only the shortfall across base and ER balances", () => {
    expect(requiredTopUp(100_000_000n, 0n, 0n)).toBe(100_000_000n);
    expect(requiredTopUp(100_000_000n, 25_000_000n, 60_000_000n)).toBe(15_000_000n);
    expect(requiredTopUp(100_000_000n, 0n, 100_000_000n)).toBe(0n);
    expect(requiredTopUp(100_000_000n, 150_000_000n, 25_000_000n)).toBe(0n);
  });

  it("decodes raw and JSON base64 keypair formats for serverless deployments", () => {
    const keypair = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const rawBase64 = Buffer.from(keypair.secretKey).toString("base64");
    const jsonBase64 = Buffer.from(JSON.stringify(Array.from(keypair.secretKey))).toString("base64");

    expect(decodeDevnetFaucetAuthorityBase64(rawBase64)).toEqual(keypair.secretKey);
    expect(decodeDevnetFaucetAuthorityBase64(jsonBase64)).toEqual(keypair.secretKey);
  });

  it("rejects malformed or incorrectly sized base64 authority values", () => {
    expect(() => decodeDevnetFaucetAuthorityBase64("not base64")).toThrow("not valid base64");
    expect(() => decodeDevnetFaucetAuthorityBase64(Buffer.from("[1,2,3]").toString("base64"))).toThrow(
      "64-byte Solana keypair",
    );
  });
});
