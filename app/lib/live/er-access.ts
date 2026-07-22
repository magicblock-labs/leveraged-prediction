import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export interface AuthorizedErAccess {
  rpcEndpoint: string;
  wsEndpoint?: string;
}

const tokenCache = new Map<string, CachedToken>();
const tokenRequests = new Map<string, Promise<CachedToken>>();

function baseEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function endpointWithToken(endpoint: string, token: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("token", token);
  return url.toString();
}

function expirationMilliseconds(expiresAt: number): number {
  return expiresAt < 10_000_000_000 ? expiresAt * 1_000 : expiresAt;
}

async function requestToken(
  rpcEndpoint: string,
  user: PublicKey,
  signMessage: SignMessage,
): Promise<CachedToken> {
  const endpoint = baseEndpoint(rpcEndpoint);
  const key = `${endpoint}:${user.toBase58()}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs > Date.now() + 30_000) return cached;

  const pending = tokenRequests.get(key);
  if (pending) return pending;

  const request = getAuthToken(endpoint, user, signMessage)
    .then(({ token, expiresAt }) => {
      const value = { token, expiresAtMs: expirationMilliseconds(expiresAt) };
      tokenCache.set(key, value);
      return value;
    })
    .finally(() => tokenRequests.delete(key));
  tokenRequests.set(key, request);
  return request;
}

export async function authorizeErAccess(
  rpcEndpoint: string,
  wsEndpoint: string | undefined,
  user: PublicKey,
  signMessage: SignMessage,
): Promise<AuthorizedErAccess> {
  const { token } = await requestToken(rpcEndpoint, user, signMessage);
  return {
    rpcEndpoint: endpointWithToken(rpcEndpoint, token),
    wsEndpoint: wsEndpoint ? endpointWithToken(wsEndpoint, token) : undefined,
  };
}
