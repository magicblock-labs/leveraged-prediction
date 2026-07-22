import { describe, expect, it } from "vitest";
import { accountDiscriminator } from "@/app/lib/live/decode";
import { decodeOraclePrice } from "@/app/lib/live/oracle";

function fullPriceUpdate(feedId: Buffer, publishTime: number): Buffer {
  const data = Buffer.alloc(133);
  accountDiscriminator("PriceUpdateV2").copy(data);
  data.writeUInt8(1, 40); // VerificationLevel::Full
  feedId.copy(data, 41);
  data.writeBigInt64LE(11_864_212_000_000n, 73);
  data.writeBigUInt64LE(1_000n, 81);
  data.writeInt32LE(8, 89);
  data.writeBigInt64LE(BigInt(publishTime), 93);
  data.writeBigInt64LE(BigInt(publishTime - 1), 101);
  data.writeBigInt64LE(11_864_212_000_000n, 109);
  data.writeBigUInt64LE(1_000n, 117);
  data.writeBigUInt64LE(99n, 125);
  return data;
}

describe("MagicBlock PriceUpdateV2 view", () => {
  it("decodes a full, fresh update using the typed Anchor schema", () => {
    const feedId = Buffer.alloc(32, 7);
    expect(decodeOraclePrice(fullPriceUpdate(feedId, 100), feedId, 101)).toEqual({
      displayPrice: 118_642.12,
      rawPrice: 11_864_212_000_000n,
      ageSeconds: 1,
      publishTime: 100,
      postedSlot: 99n,
    });
  });

  it("fails closed on the wrong feed or stale publish time", () => {
    const feedId = Buffer.alloc(32, 7);
    const update = fullPriceUpdate(feedId, 100);
    expect(() => decodeOraclePrice(update, Buffer.alloc(32, 8), 101)).toThrow(/feed ID/);
    expect(() => decodeOraclePrice(update, feedId, 103)).toThrow(/stale or invalid/);
  });

  it("tolerates one second of publisher clock skew but rejects more", () => {
    const feedId = Buffer.alloc(32, 7);
    const update = fullPriceUpdate(feedId, 101);

    expect(decodeOraclePrice(update, feedId, 100).ageSeconds).toBe(0);
    expect(() => decodeOraclePrice(fullPriceUpdate(feedId, 102), feedId, 100)).toThrow(
      /stale or invalid/,
    );
  });

  it("accepts the MagicBlock ephemeral oracle discriminator", () => {
    const feedId = Buffer.alloc(32, 7);
    const update = fullPriceUpdate(feedId, 100);
    Buffer.from([234, 161, 14, 36, 172, 239, 15, 232]).copy(update);

    expect(decodeOraclePrice(update, feedId, 101).rawPrice).toBe(11_864_212_000_000n);
  });

  it("rejects an unknown account discriminator", () => {
    const feedId = Buffer.alloc(32, 7);
    const update = fullPriceUpdate(feedId, 100);
    Buffer.alloc(8, 255).copy(update);

    expect(() => decodeOraclePrice(update, feedId, 101)).toThrow(/not a recognized/);
  });
});
