import type { Direction } from "@/app/lib/domain";

export type OpenIntentStatus =
  | "preparing"
  | "onboarding"
  | "ready"
  | "submitting"
  | "confirming"
  | "accepted"
  | "ambiguous"
  | "failed";

export interface OpenPositionIntent {
  version: 1;
  id: string;
  user: string;
  marketId: number;
  direction: Direction;
  collateralMinor: string;
  taskSaltHex: string;
  nonce?: number;
  erEndpoint?: string;
  baseSignatures: string[];
  erSignature?: string;
  status: OpenIntentStatus;
  message?: string;
  createdAt: number;
  updatedAt: number;
}

const KEY_PREFIX = "leveraged-prediction:open-intent:v1";

function storageKey(user: string, marketId: number): string {
  return `${KEY_PREFIX}:${user}:${marketId}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("task salt is not 32-byte hex");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function createOpenIntent(
  user: string,
  marketId: number,
  direction: Direction,
  collateralMinor: bigint,
  taskSalt: Uint8Array,
  now = Date.now(),
): OpenPositionIntent {
  return {
    version: 1,
    id: globalThis.crypto.randomUUID(),
    user,
    marketId,
    direction,
    collateralMinor: collateralMinor.toString(),
    taskSaltHex: bytesToHex(taskSalt),
    baseSignatures: [],
    status: "preparing",
    createdAt: now,
    updatedAt: now,
  };
}

export function loadOpenIntent(user: string, marketId: number): OpenPositionIntent | null {
  if (typeof window === "undefined") return null;
  const encoded = window.localStorage.getItem(storageKey(user, marketId));
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded) as OpenPositionIntent;
    if (
      value.version !== 1 ||
      value.user !== user ||
      value.marketId !== marketId ||
      !["up", "down"].includes(value.direction) ||
      !/^[0-9]+$/.test(value.collateralMinor) ||
      !/^[0-9a-f]{64}$/i.test(value.taskSaltHex)
    ) {
      throw new Error("invalid intent fields");
    }
    return value;
  } catch {
    window.localStorage.removeItem(storageKey(user, marketId));
    return null;
  }
}

export function saveOpenIntent(intent: OpenPositionIntent): OpenPositionIntent {
  const next = { ...intent, updatedAt: Date.now() };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey(next.user, next.marketId), JSON.stringify(next));
  }
  return next;
}

export function clearOpenIntent(user: string, marketId: number): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(storageKey(user, marketId));
  }
}

export function requiresIntentRecovery(intent: OpenPositionIntent): boolean {
  return intent.status === "submitting" || intent.status === "confirming" || intent.status === "ambiguous";
}
