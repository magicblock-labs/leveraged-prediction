import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandDeck } from "@/app/components/command-deck";
import type { MarketSnapshot } from "@/app/lib/domain";

const snapshot: MarketSnapshot = {
  mode: "live",
  marketId: 1,
  marketLabel: "BTC / USD",
  gameLabel: "BTC",
  currentPrice: 100,
  priceExponent: -8,
  priceHistory: [],
  feedHealth: "live",
  feedAgeSeconds: 0.2,
  marketMode: "open",
  activePositions: 0,
  maxPositions: 8,
  walletAddress: "11111111111111111111111111111111",
  walletBalanceUsd: 100,
  fallbackClaimableUsd: 0,
  plays: [],
  capturedAt: 1,
};

function renderDeck(props: {
  sessionReady: boolean;
  submissionReady: boolean;
  busy?: boolean;
  statusMessage?: string | null;
}) {
  return renderToStaticMarkup(createElement(CommandDeck, {
    snapshot,
    occupiedPositions: 0,
    sessionAllowanceUsd: props.sessionReady ? 100 : null,
    onPlay: () => undefined,
    ...props,
  }));
}

describe("play intent controls", () => {
  it("keeps direction buttons available to request an inactive session", () => {
    const html = renderDeck({ sessionReady: false, submissionReady: false });

    expect(html).toContain("Choose Up or Down to start a one-hour session");
    expect(html).not.toMatch(/class="play-button play-(?:up|down)" disabled/);
  });

  it("waits for instant-play preparation after a session is active", () => {
    const html = renderDeck({ sessionReady: true, submissionReady: false });

    expect(html).toMatch(/class="play-button play-up" disabled/);
    expect(html).toMatch(/class="play-button play-down" disabled/);
  });

  it("explains that a submitted play is still being reconciled", () => {
    const html = renderDeck({
      sessionReady: true,
      submissionReady: true,
      busy: true,
      statusMessage: "Play sent · waiting for Your Plays…",
    });

    expect(html).toMatch(/class="play-button play-up" disabled/);
    expect(html).toContain("Play sent · waiting for Your Plays…");
  });
});
