import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  requiresIntentRecovery,
  type OpenPositionIntent,
} from "@/app/lib/live/intent-store";

describe("durable open intents", () => {
  it("round-trips the task salt without changing its bytes", () => {
    const salt = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(hexToBytes(bytesToHex(salt))).toEqual(salt);
  });

  it("blocks retries only while an economic submission is unresolved", () => {
    const intent = { status: "onboarding" } as OpenPositionIntent;
    expect(requiresIntentRecovery(intent)).toBe(false);
    expect(requiresIntentRecovery({ ...intent, status: "submitting" })).toBe(true);
    expect(requiresIntentRecovery({ ...intent, status: "confirming" })).toBe(true);
    expect(requiresIntentRecovery({ ...intent, status: "ambiguous" })).toBe(true);
    expect(requiresIntentRecovery({ ...intent, status: "failed" })).toBe(false);
  });

  it("rejects malformed task-salt persistence", () => {
    expect(() => hexToBytes("abc")).toThrow(/32-byte hex/);
  });
});
