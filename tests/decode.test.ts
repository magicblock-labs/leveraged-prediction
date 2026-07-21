import { describe, expect, it } from "vitest";
import {
  accountDiscriminator,
  decodeMarket,
  decodeProtocolConfig,
  decodeUserPositions,
} from "@/app/lib/live/decode";

describe("final ABI account decoders", () => {
  it("decodes the 116-byte Market layout", () => {
    const data = Buffer.alloc(116);
    accountDiscriminator("Market").copy(data);
    data.writeUInt16LE(7, 8);
    Buffer.alloc(32, 3).copy(data, 10);
    Buffer.alloc(32, 9).copy(data, 42);
    data.writeUInt32LE(4, 106);
    data.writeUInt32LE(21, 110);
    data.writeUInt8(1, 114);

    const market = decodeMarket(data);
    expect(market.marketId).toBe(7);
    expect(market.oracle).toEqual(Buffer.alloc(32, 3));
    expect(market.oracleFeedId).toEqual(Buffer.alloc(32, 9));
    expect(market.activePositions).toBe(4);
    expect(market.nextPositionNonce).toBe(21);
    expect(market.mode).toBe("close-only");
  });

  it("decodes compact positions without inventing settled history", () => {
    const data = Buffer.alloc(452);
    accountDiscriminator("UserPositions").copy(data);
    data.writeUInt32LE(1, 8);
    data.writeUInt16LE(7, 12);
    data.writeUInt32LE(42, 14);
    Buffer.alloc(32, 5).copy(data, 18);
    data.writeUInt32LE(10_000_000, 50);
    data.writeBigInt64LE(11_864_212_000_000n, 54);
    data.writeUInt32LE(1_800_000_000, 62);
    data.writeUInt8(1, 66);

    expect(decodeUserPositions(data)).toEqual([
      {
        marketId: 7,
        nonce: 42,
        taskSalt: Buffer.alloc(32, 5),
        collateral: 10_000_000,
        entryPrice: 11_864_212_000_000n,
        expiresAt: 1_800_000_000,
        direction: "down",
      },
    ]);
  });

  it("reads the global collateral mint from ProtocolConfig", () => {
    const data = Buffer.alloc(105);
    accountDiscriminator("ProtocolConfig").copy(data);
    Buffer.alloc(32, 11).copy(data, 72);
    expect(decodeProtocolConfig(data).collateralMint).toEqual(Buffer.alloc(32, 11));
  });

  it("rejects a mismatched account discriminator", () => {
    expect(() => decodeMarket(Buffer.alloc(116))).toThrow(/discriminator mismatch/);
  });
});
