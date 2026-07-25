import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionIndicator } from "@/app/components/session-indicator";

describe("session navbar indicator", () => {
  it("offers session setup while inactive", () => {
    const html = renderToStaticMarkup(createElement(SessionIndicator, {
      active: false,
      onRequestSetup: () => undefined,
    }));

    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Session inactive — start session"');
  });

  it("remains informational while active", () => {
    const html = renderToStaticMarkup(createElement(SessionIndicator, {
      active: true,
      onRequestSetup: () => undefined,
    }));

    expect(html).not.toContain("<button");
    expect(html).toContain('aria-label="Session active"');
  });
});
