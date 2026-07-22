import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { accountDiscriminator } from "@/app/lib/live/decode";
import { ORACLE_PROGRAM_ID } from "@/app/lib/live/config";

export const ORACLE_EXPONENT = 8;
export const ORACLE_MAX_AGE_SECONDS = 2;
const ORACLE_MAX_FUTURE_SKEW_SECONDS = 1;
const ORACLE_MAX_CONFIDENCE_BPS = 1;
const PRICE_SCALE = 10 ** ORACLE_EXPONENT;
const PYTH_PRICE_UPDATE_DISCRIMINATOR = accountDiscriminator("PriceUpdateV2");
const PRICE_UPDATE_DISCRIMINATORS = [
  Buffer.from([234, 161, 14, 36, 172, 239, 15, 232]),
  PYTH_PRICE_UPDATE_DISCRIMINATOR,
];

interface PriceUpdateAccount {
  verificationLevel: Record<string, unknown>;
  priceMessage: {
    feedId: number[];
    price: { toString(): string };
    conf: { toString(): string };
    exponent: number;
    publishTime: { toString(): string };
  };
  postedSlot: { toString(): string };
}

export interface OraclePrice {
  displayPrice: number;
  rawPrice: bigint;
  ageSeconds: number;
  publishTime: number;
  postedSlot: bigint;
}

const priceUpdateIdl = {
  address: ORACLE_PROGRAM_ID.toBase58(),
  metadata: {
    name: "magicblock_pricing_oracle_view",
    version: "0.1.0",
    spec: "0.1.0",
  },
  instructions: [],
  accounts: [
    {
      name: "PriceUpdateV2",
      discriminator: [...PYTH_PRICE_UPDATE_DISCRIMINATOR],
    },
  ],
  types: [
    {
      name: "PriceUpdateV2",
      type: {
        kind: "struct",
        fields: [
          { name: "writeAuthority", type: "pubkey" },
          { name: "verificationLevel", type: { defined: { name: "VerificationLevel" } } },
          { name: "priceMessage", type: { defined: { name: "PriceFeedMessage" } } },
          { name: "postedSlot", type: "u64" },
        ],
      },
    },
    {
      name: "VerificationLevel",
      type: {
        kind: "enum",
        variants: [
          { name: "Partial", fields: [{ name: "numSignatures", type: "u8" }] },
          { name: "Full" },
        ],
      },
    },
    {
      name: "PriceFeedMessage",
      type: {
        kind: "struct",
        fields: [
          { name: "feedId", type: { array: ["u8", 32] } },
          { name: "price", type: "i64" },
          { name: "conf", type: "u64" },
          { name: "exponent", type: "i32" },
          { name: "publishTime", type: "i64" },
          { name: "prevPublishTime", type: "i64" },
          { name: "emaPrice", type: "i64" },
          { name: "emaConf", type: "u64" },
        ],
      },
    },
  ],
} as Idl;

const priceCoder = new BorshAccountsCoder(priceUpdateIdl);

function asBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decodeOraclePrice(
  data: Buffer,
  expectedFeedId: Uint8Array,
  nowSeconds: number,
): OraclePrice {
  if (data.length < 133) throw new Error("Oracle price account has invalid data");
  const discriminator = data.subarray(0, 8);
  if (!PRICE_UPDATE_DISCRIMINATORS.some((candidate) => discriminator.equals(candidate))) {
    throw new Error("Oracle account is not a recognized price-update account");
  }
  const canonicalData = Buffer.from(data);
  PYTH_PRICE_UPDATE_DISCRIMINATOR.copy(canonicalData, 0);
  const update = priceCoder.decode("PriceUpdateV2", canonicalData) as PriceUpdateAccount;
  const message = update.priceMessage;
  const rawPrice = BigInt(message.price.toString());
  const confidence = BigInt(message.conf.toString());
  const publishTime = Number(message.publishTime.toString());
  const postedSlot = BigInt(update.postedSlot.toString());
  const measuredAgeSeconds = nowSeconds - publishTime;
  const ageSeconds = Math.max(0, measuredAgeSeconds);

  if (!bytesEqual(asBytes(message.feedId), expectedFeedId)) {
    throw new Error("Oracle feed ID does not match the configured Market");
  }
  if (message.exponent !== ORACLE_EXPONENT) {
    throw new Error(`Oracle exponent ${message.exponent} does not match ${ORACLE_EXPONENT}`);
  }
  const fullyVerified =
    "full" in update.verificationLevel || "Full" in update.verificationLevel;
  if (!fullyVerified || postedSlot === 0n) {
    throw new Error("Oracle update is not fully verified and posted");
  }
  if (
    rawPrice <= 0n ||
    measuredAgeSeconds < -ORACLE_MAX_FUTURE_SKEW_SECONDS ||
    ageSeconds > ORACLE_MAX_AGE_SECONDS
  ) {
    throw new Error(`Oracle update is stale or invalid (${measuredAgeSeconds.toFixed(1)}s old)`);
  }
  if (confidence * 10_000n > rawPrice * BigInt(ORACLE_MAX_CONFIDENCE_BPS)) {
    throw new Error("Oracle confidence interval exceeds the market limit");
  }

  return {
    displayPrice: Number(rawPrice) / PRICE_SCALE,
    rawPrice,
    ageSeconds,
    publishTime,
    postedSlot,
  };
}
