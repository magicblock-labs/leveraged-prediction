import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FaucetToast } from "@/app/components/faucet-toast";

describe("faucet toast", () => {
  it("renders partial success as an alert with the Solana faucet action", () => {
    const html = renderToStaticMarkup(createElement(FaucetToast, {
      message: "SOL airdrop failed · $100.00 test USDC minted",
      tone: "warning",
      actionUrl: "https://faucet.solana.com/",
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("SOL airdrop failed");
    expect(html).toContain('href="https://faucet.solana.com/"');
    expect(html).toContain("Get devnet SOL from Solana faucet");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("renders no markup without a message", () => {
    expect(renderToStaticMarkup(createElement(FaucetToast, {
      message: null,
      tone: "success",
      actionUrl: null,
    }))).toBe("");
  });
});
