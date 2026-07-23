import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  devnetFaucetInfo,
  fundDevnetWallet,
} from "@/app/lib/live/devnet-faucet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function GET() {
  return noStore(devnetFaucetInfo());
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return noStore({ error: "Test-funds requests must come from this application" }, { status: 403 });
  }

  try {
    const body = await request.json() as { wallet?: unknown };
    if (typeof body.wallet !== "string") {
      return noStore({ error: "A wallet address is required" }, { status: 400 });
    }
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(body.wallet);
    } catch {
      return noStore({ error: "Wallet address is invalid" }, { status: 400 });
    }
    const result = await fundDevnetWallet(wallet);
    return noStore(result, { status: result.ok ? 200 : 503 });
  } catch (cause) {
    return noStore({
      error: cause instanceof Error ? cause.message : "Test-funds request failed",
    }, { status: 503 });
  }
}
