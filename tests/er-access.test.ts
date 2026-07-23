import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAuthToken } = vi.hoisted(() => ({ getAuthToken: vi.fn() }));

vi.mock("@magicblock-labs/ephemeral-rollups-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@magicblock-labs/ephemeral-rollups-sdk")>(),
  getAuthToken,
}));

import { authorizeErAccess } from "@/app/lib/live/er-access";

describe("authorized ER access", () => {
  beforeEach(() => {
    getAuthToken.mockReset();
  });

  it("wallet-signs once and adds the token to RPC and websocket URLs", async () => {
    const user = Keypair.generate().publicKey;
    const signMessage = vi.fn(async () => new Uint8Array([1, 2, 3]));
    getAuthToken.mockResolvedValue({
      token: "wallet-token",
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });

    const first = await authorizeErAccess(
      "http://127.0.0.1:6699?network=local",
      "ws://127.0.0.1:6700",
      user,
      signMessage,
    );
    const second = await authorizeErAccess(
      "http://127.0.0.1:6699?network=local",
      "ws://127.0.0.1:6700",
      user,
      signMessage,
    );

    expect(getAuthToken).toHaveBeenCalledOnce();
    expect(getAuthToken).toHaveBeenCalledWith(
      "http://127.0.0.1:6699",
      user,
      signMessage,
    );
    expect(first).toEqual({
      rpcEndpoint: "http://127.0.0.1:6699/?network=local&token=wallet-token",
      wsEndpoint: "ws://127.0.0.1:6700/?token=wallet-token",
    });
    expect(second).toEqual(first);
  });
});
