import { describe, expect, it } from "vitest";
import { normalizeErEndpoint } from "@/app/lib/live/router";

describe("ER endpoint normalization", () => {
  it("accepts router hostnames and full URLs", () => {
    expect(normalizeErEndpoint("devnet-as.magicblock.app")).toBe("https://devnet-as.magicblock.app/");
    expect(normalizeErEndpoint("https://devnet-as.magicblock.app/")).toBe("https://devnet-as.magicblock.app/");
  });
});
