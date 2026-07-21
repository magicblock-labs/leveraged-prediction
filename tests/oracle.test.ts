import { describe, expect, it } from "vitest";
import { accountDiscriminator } from "@/app/lib/live/decode";
import { decodeOraclePrice } from "@/app/lib/live/read-snapshot";

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
      ageSeconds: 1,
    });
  });

  it("fails closed on the wrong feed or stale publish time", () => {
    const feedId = Buffer.alloc(32, 7);
    const update = fullPriceUpdate(feedId, 100);
    expect(() => decodeOraclePrice(update, Buffer.alloc(32, 8), 101)).toThrow(/feed ID/);
    expect(() => decodeOraclePrice(update, feedId, 103)).toThrow(/stale or invalid/);
  });
});
