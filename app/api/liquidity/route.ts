import { NextRequest, NextResponse } from "next/server";
import type { LiquiditySnapshotError } from "@/app/lib/liquidity";
import { readLiquiditySnapshot } from "@/app/lib/live/read-liquidity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get("wallet") ?? undefined;
    return NextResponse.json(await readLiquiditySnapshot(wallet), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const body: LiquiditySnapshotError = {
      code: "LIVE_UNAVAILABLE",
      error: error instanceof Error ? error.message : "Liquidity snapshot failed",
    };
    return NextResponse.json(body, { status: 503 });
  }
}
