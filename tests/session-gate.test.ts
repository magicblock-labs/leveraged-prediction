import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionGate } from "@/app/components/session-gate";

const sharedProps = {
  visible: true,
  busy: false,
  defaultAllowanceUsd: 100,
  walletBalanceUsd: null,
  error: null,
  faucetAvailable: true,
  faucetBusy: false,
  onStart: () => undefined,
  onFund: () => undefined,
  onDismiss: () => undefined,
};

describe("session setup dialog", () => {
  it("presents exactly one base step and one ER step before showing buying power", () => {
    const html = renderToStaticMarkup(createElement(SessionGate, {
      ...sharedProps,
      hasStoredSession: false,
      progress: null,
    }));

    expect(html).toContain("Start your play session");
    expect(html).toContain("Close session setup");
    expect(html.match(/session-step-copy/g)).toHaveLength(2);
    expect(html).toContain("Deposit to arena");
    expect(html).toContain("Base network");
    expect(html).toContain("Activate session");
    expect(html).toContain("MagicBlock ER");
    expect(html).toContain("Buying power appears after your deposit reaches the arena");
    expect(html).not.toContain("Arena balance");
    expect(html).toContain("Two wallet approvals total");
  });

  it("shows the base step as active while the deposit is being prepared", () => {
    const html = renderToStaticMarkup(createElement(SessionGate, {
      ...sharedProps,
      busy: true,
      hasStoredSession: true,
      progress: {
        phase: "depositing",
        message: "Step 1 of 2 · Depositing to the arena…",
      },
    }));

    expect(html).toContain("Finish your play session");
    expect(html).toContain('class="active"');
    expect(html).toContain("Step 1 of 2 · Depositing…");
  });

  it("shows the ER step after the arena balance becomes available", () => {
    const html = renderToStaticMarkup(createElement(SessionGate, {
      ...sharedProps,
      busy: true,
      walletBalanceUsd: 75,
      hasStoredSession: true,
      progress: {
        phase: "approving",
        message: "Step 2 of 2 · Approving the play allowance on the ER…",
      },
    }));

    expect(html).toContain('class="complete"');
    expect(html).toContain('class="active"');
    expect(html).toContain("Arena balance");
    expect(html).toContain("$75.00");
    expect(html).toContain("Step 2 of 2 · Activating…");
  });
});
