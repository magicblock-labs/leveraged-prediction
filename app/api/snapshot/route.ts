import { NextRequest, NextResponse } from "next/server";
import type { SnapshotError } from "@/app/lib/domain";
import { createFixtureSnapshot } from "@/app/lib/fixtures";
import { readLiveSnapshot } from "@/app/lib/live/read-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const mode = process.env.LEVERAGED_PREDICTION_DATA_MODE ?? "fixture";
  if (mode !== "live") {
    return NextResponse.json(createFixtureSnapshot(), {
      headers: { "cache-control": "no-store" },
    });
  }

  try {
    const wallet = request.nextUrl.searchParams.get("wallet") ?? undefined;
    return NextResponse.json(await readLiveSnapshot(wallet), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const body: SnapshotError = {
      code: "LIVE_UNAVAILABLE",
      error: error instanceof Error ? error.message : "Live snapshot failed",
    };
    return NextResponse.json(body, { status: 503 });
  }
}
