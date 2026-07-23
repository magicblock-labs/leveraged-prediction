import { describe, expect, it } from "vitest";
import {
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
});
