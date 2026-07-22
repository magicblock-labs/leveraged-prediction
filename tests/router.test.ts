import { afterEach, describe, expect, it, vi } from "vitest";
import { getDelegationStatus, normalizeErEndpoint } from "@/app/lib/live/router";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ER endpoint normalization", () => {
  it("accepts router hostnames and full URLs", () => {
    expect(normalizeErEndpoint("devnet-as.magicblock.app")).toBe("https://devnet-as.magicblock.app/");
    expect(normalizeErEndpoint("https://devnet-as.magicblock.app/")).toBe("https://devnet-as.magicblock.app/");
  });
});

describe("delegation routing", () => {
  it("uses the router's delegation-status endpoint", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { isDelegated: true, fqdn: "arena.example" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(getDelegationStatus("https://router.example/", "account-1")).resolves.toEqual({
      isDelegated: true,
      fqdn: "arena.example",
    });
    expect(request).toHaveBeenCalledWith(
      "https://router.example/getDelegationStatus",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses a direct local ER endpoint when the local router omits fqdn", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { isDelegated: true } }), { status: 200 }),
    );

    await expect(getDelegationStatus("http://127.0.0.1:7799", "account-1")).resolves.toEqual({
      isDelegated: true,
      fqdn: "http://127.0.0.1:7799",
    });
  });
});
