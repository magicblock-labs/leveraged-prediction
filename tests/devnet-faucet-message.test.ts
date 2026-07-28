import { describe, expect, it } from "vitest";
import {
  devnetFaucetSolFailureMessage,
  devnetFaucetSuccessMessage,
  isSolOnlyFaucetFailure,
  SOLANA_DEVNET_FAUCET_URL,
} from "@/app/hooks/use-devnet-faucet";

function result(
  added: { sol: number; usdc: number },
  failures = { sol: null as string | null, usdc: null as string | null },
  arenaUsdc: number | null = 107.574814,
) {
  return {
    enabled: true,
    ok: true,
    targetSol: 0.1,
    targetUsdc: 100,
    balances: {
      sol: 0.1,
      baseUsdc: 0,
      erUsdc: 107.574814,
      arenaUsdc,
      totalUsdc: 107.574814,
    },
    added,
    failures,
    errors: [],
  };
}

describe("devnet faucet success message", () => {
  it("describes an above-target request as already funded", () => {
    expect(devnetFaucetSuccessMessage(result({ sol: 0, usdc: 0 }))).toBe(
      "Already funded · $107.57 arena balance",
    );
  });

  it("reports only the assets actually added", () => {
    expect(devnetFaucetSuccessMessage(result({ sol: 0.05, usdc: 25 }))).toBe(
      "$25.00 test USDC added + 0.05 SOL added · $107.57 arena balance",
    );
  });

  it("does not reveal a base balance before the ER deposit", () => {
    expect(devnetFaucetSuccessMessage(result(
      { sol: 0, usdc: 100 },
      undefined,
      null,
    ))).toBe(
      "$100.00 test USDC added · deposit to arena to use it",
    );
    expect(devnetFaucetSuccessMessage(result(
      { sol: 0, usdc: 0 },
      undefined,
      null,
    ))).toBe(
      "Test funds ready · deposit to arena to see buying power",
    );
  });

  it("preserves a successful mint when only the SOL airdrop fails", () => {
    const partial = result(
      { sol: 0, usdc: 100 },
      { sol: "airdrop rate limit", usdc: null },
    );

    expect(devnetFaucetSolFailureMessage(partial)).toBe(
      "SOL airdrop failed · $100.00 test USDC minted",
    );
    expect(isSolOnlyFaucetFailure(partial)).toBe(true);
    expect(SOLANA_DEVNET_FAUCET_URL).toBe("https://faucet.solana.com/");
  });

  it("reports existing test USDC when SOL fails without a new mint", () => {
    expect(devnetFaucetSolFailureMessage(result(
      { sol: 0, usdc: 0 },
      { sol: "airdrop rate limit", usdc: null },
    ))).toBe(
      "SOL airdrop failed · $107.57 arena balance is ready",
    );
  });

  it("does not reveal a base balance when SOL fails before the ER deposit", () => {
    expect(devnetFaucetSolFailureMessage(result(
      { sol: 0, usdc: 0 },
      { sol: "airdrop rate limit", usdc: null },
      null,
    ))).toBe(
      "SOL airdrop failed · test USDC is ready to deposit",
    );
  });

  it("does not classify a USDC failure as safe partial success", () => {
    expect(isSolOnlyFaucetFailure(result(
      { sol: 0.1, usdc: 0 },
      { sol: null, usdc: "mint failed" },
    ))).toBe(false);
  });
});
