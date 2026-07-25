export interface LeaderboardEntry {
  rank: number;
  user: string;
  trades: number;
  wins: number;
  losses: number;
  volume: string;
}

export interface UserLeaderboardStats {
  rank: number | null;
  user: string;
  trades: number;
  wins: number;
  losses: number;
  volume: string;
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  userStats: UserLeaderboardStats | null;
  totalVolume: string | null;
  stale: boolean;
}

interface IndexerMeta {
  stale: boolean;
  next_cursor?: string;
}

interface IndexerEnvelope<T> {
  data: T;
  meta: IndexerMeta;
}

const MAX_LEADERBOARD_PAGES = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Indexer returned an invalid ${field}`);
  }
  return Number(value);
}

function readMinorUnits(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Indexer returned an invalid ${field}`);
  }
  return value;
}

function readAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 44 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  ) {
    throw new Error("Indexer returned an invalid wallet address");
  }
  return value;
}

function parseEntry(value: unknown): LeaderboardEntry {
  if (!isRecord(value)) throw new Error("Indexer returned an invalid leaderboard row");
  return {
    rank: readCount(value.rank, "rank"),
    user: readAddress(value.user),
    trades: readCount(value.trades, "trade count"),
    wins: readCount(value.wins, "win count"),
    losses: readCount(value.losses, "loss count"),
    volume: readMinorUnits(value.volume, "volume"),
  };
}

function parseStats(value: unknown): UserLeaderboardStats {
  if (!isRecord(value)) throw new Error("Indexer returned invalid user stats");
  const rank = value.rank === null ? null : readCount(value.rank, "rank");
  return {
    rank,
    user: readAddress(value.user),
    trades: readCount(value.trades, "trade count"),
    wins: readCount(value.wins, "win count"),
    losses: readCount(value.losses, "loss count"),
    volume: readMinorUnits(value.volume, "volume"),
  };
}

function parseMeta(value: unknown): IndexerMeta {
  if (!isRecord(value) || typeof value.stale !== "boolean") {
    throw new Error("Indexer returned invalid response metadata");
  }
  if (value.next_cursor !== undefined && typeof value.next_cursor !== "string") {
    throw new Error("Indexer returned an invalid pagination cursor");
  }
  return {
    stale: value.stale,
    next_cursor: value.next_cursor,
  };
}

async function request<T>(
  url: string,
  parseData: (value: unknown) => T,
  signal: AbortSignal,
): Promise<IndexerEnvelope<T>> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
      ? body.error.message
      : "Leaderboard data is temporarily unavailable";
    throw new Error(message);
  }
  if (!isRecord(body)) throw new Error("Indexer returned an invalid response");
  return {
    data: parseData(body.data),
    meta: parseMeta(body.meta),
  };
}

export function leaderboardApiUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_INDEXER_API_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function formatLeaderboardUsdc(minorUnits: string | null): string {
  if (minorUnits === null || !/^\d+$/.test(minorUnits)) return "—";
  const digits = minorUnits.padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-6, -4);
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `$${grouped}.${fraction}`;
}

export async function fetchLeaderboardResult(
  baseUrl: string,
  marketId: number,
  wallet: string | null,
  signal: AbortSignal,
): Promise<LeaderboardResult> {
  const entries: LeaderboardEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let stale = false;
  let complete = false;

  for (let page = 0; page < MAX_LEADERBOARD_PAGES; page += 1) {
    const query = new URLSearchParams({
      period: "all",
      market_id: marketId.toString(),
      limit: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await request(
      `${baseUrl}/v1/leaderboards?${query}`,
      (value) => {
        if (!Array.isArray(value)) {
          throw new Error("Indexer returned an invalid leaderboard");
        }
        return value.map(parseEntry);
      },
      signal,
    );
    entries.push(...response.data);
    stale ||= response.meta.stale;
    cursor = response.meta.next_cursor;
    if (!cursor) {
      complete = true;
      break;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Indexer repeated a leaderboard cursor");
    }
    seenCursors.add(cursor);
  }

  const stats = wallet
    ? await request(
        `${baseUrl}/v1/users/${encodeURIComponent(wallet)}/stats?period=all&market_id=${marketId}`,
        parseStats,
        signal,
      )
    : null;
  stale ||= stats?.meta.stale ?? false;

  return {
    entries,
    userStats: stats?.data ?? null,
    totalVolume: complete
      ? entries.reduce((sum, entry) => sum + BigInt(entry.volume), 0n).toString()
      : null,
    stale,
  };
}
