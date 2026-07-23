import { Keypair, PublicKey } from "@solana/web3.js";

export const DEFAULT_SESSION_ALLOWANCE_USD = 100;
export const SESSION_DURATION_SECONDS = 60 * 60;

export interface StoredGameSession {
  user: string;
  programId: string;
  sessionToken: string;
  sessionSignerSecret: number[];
  allowanceMinor: string;
  validUntil: number;
  setupComplete: boolean;
}

function storageKey(user: string, programId: string): string {
  return `leveraged-prediction:session:${programId}:${user}`;
}

export function sessionKeypair(session: StoredGameSession): Keypair {
  return keypairFromStoredSecret(
    session.sessionSignerSecret,
    "Stored session signer is invalid",
  );
}

function keypairFromStoredSecret(secret: number[], errorMessage: string): Keypair {
  if (
    secret.length !== 64 ||
    !secret.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    )
  ) {
    throw new Error(errorMessage);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function validateStoredSessionShape(
  value: unknown,
  user: PublicKey,
  programId: PublicKey,
): StoredGameSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<StoredGameSession>;
  if (
    session.user !== user.toBase58() ||
    session.programId !== programId.toBase58() ||
    typeof session.sessionToken !== "string" ||
    typeof session.allowanceMinor !== "string" ||
    typeof session.validUntil !== "number" ||
    (session.setupComplete !== undefined && typeof session.setupComplete !== "boolean") ||
    !Array.isArray(session.sessionSignerSecret)
  ) return null;
  try {
    const keypair = sessionKeypair(session as StoredGameSession);
    new PublicKey(session.sessionToken);
    BigInt(session.allowanceMinor);
    if (session.validUntil <= 0 || keypair.publicKey.equals(PublicKey.default)) return null;
    return {
      user: session.user,
      programId: session.programId,
      sessionToken: session.sessionToken,
      sessionSignerSecret: session.sessionSignerSecret,
      allowanceMinor: session.allowanceMinor,
      validUntil: session.validUntil,
      setupComplete: session.setupComplete ?? false,
    } as StoredGameSession;
  } catch {
    return null;
  }
}

export function loadGameSession(
  user: PublicKey,
  programId: PublicKey,
): StoredGameSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(storageKey(user.toBase58(), programId.toBase58()));
  if (!raw) return null;
  try {
    return validateStoredSessionShape(JSON.parse(raw), user, programId);
  } catch {
    return null;
  }
}

export function saveGameSession(session: StoredGameSession): void {
  window.sessionStorage.setItem(
    storageKey(session.user, session.programId),
    JSON.stringify(session),
  );
}

export function clearGameSession(user: PublicKey, programId: PublicKey): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(storageKey(user.toBase58(), programId.toBase58()));
}
