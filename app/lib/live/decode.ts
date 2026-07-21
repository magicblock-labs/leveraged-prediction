import { createHash } from "node:crypto";

export interface DecodedMarket {
  marketId: number;
  oracle: Uint8Array;
  oracleFeedId: Uint8Array;
  activePositions: number;
  nextPositionNonce: number;
  mode: "open" | "close-only";
}

export interface DecodedCompactPosition {
  marketId: number;
  nonce: number;
  collateral: number;
  entryPrice: bigint;
  expiresAt: number;
  direction: "up" | "down";
}

export interface DecodedProtocolConfig {
  collateralMint: Uint8Array;
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function assertAccount(data: Buffer, name: string, minimumLength: number): void {
  if (data.length < minimumLength) {
    throw new Error(`${name} account is ${data.length} bytes; expected at least ${minimumLength}`);
  }
  if (!data.subarray(0, 8).equals(discriminator(name))) {
    throw new Error(`${name} account discriminator mismatch`);
  }
}

export function decodeMarket(data: Buffer): DecodedMarket {
  assertAccount(data, "Market", 116);
  return {
    marketId: data.readUInt16LE(8),
    oracle: data.subarray(10, 42),
    oracleFeedId: data.subarray(42, 74),
    activePositions: data.readUInt32LE(106),
    nextPositionNonce: data.readUInt32LE(110),
    mode: data.readUInt8(114) === 0 ? "open" : "close-only",
  };
}

export function decodeProtocolConfig(data: Buffer): DecodedProtocolConfig {
  assertAccount(data, "ProtocolConfig", 105);
  return { collateralMint: data.subarray(72, 104) };
}

export function decodeUserPositions(data: Buffer): DecodedCompactPosition[] {
  assertAccount(data, "UserPositions", 12);
  const count = data.readUInt32LE(8);
  if (count > 8) throw new Error(`UserPositions contains invalid length ${count}`);
  const expectedLength = 12 + count * 55;
  if (data.length < expectedLength) {
    throw new Error(`UserPositions is truncated: ${data.length} < ${expectedLength}`);
  }

  return Array.from({ length: count }, (_, index) => {
    const offset = 12 + index * 55;
    const direction = data.readUInt8(offset + 54);
    if (direction > 1) throw new Error(`Position ${index} has invalid direction ${direction}`);
    return {
      marketId: data.readUInt16LE(offset),
      nonce: data.readUInt32LE(offset + 2),
      collateral: data.readUInt32LE(offset + 38),
      entryPrice: data.readBigInt64LE(offset + 42),
      expiresAt: data.readUInt32LE(offset + 50),
      direction: direction === 0 ? "up" : "down",
    };
  });
}

export const accountDiscriminator = discriminator;
