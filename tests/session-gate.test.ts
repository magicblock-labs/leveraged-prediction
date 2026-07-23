import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionGate } from "@/app/components/session-gate";

const sharedProps = {
  visible: true,
  busy: false,
  defaultAllowanceUsd: 100,
  walletBalanceUsd: 100,
  error: null,
  faucetAvailable: true,
  faucetBusy: false,
  onStart: () => undefined,
  onFund: () => undefined,
};

describe("session setup dialog", () => {
  it("presents setup as one user-facing action", () => {
    const html = renderToStaticMarkup(createElement(SessionGate, {
      ...sharedProps,
      hasStoredSession: false,
      progress: {
        phase: "creating",
        message: "Creating your one-hour play session…",
      },
    }));

    expect(html).toContain("Start your play session");
    expect(html).not.toContain("session-stepper");
    expect(html).toContain("Starting a session authorizes");
  });

  it("marks session creation complete when local session state exists", () => {
    const html = renderToStaticMarkup(createElement(SessionGate, {
      ...sharedProps,
      hasStoredSession: true,
      progress: {
        phase: "preparing-accounts",
        message: "Session found. Continue the remaining setup.",
      },
    }));

    expect(html).toContain("Finish your play session");
    expect(html).toContain("without creating another one");
    expect(html).toContain("Continue setup");
  });
});
