export interface IndexerMeta {
  as_of: string;
  projection_high_water_mark: number | null;
  refresh_version: number;
  stale: boolean;
  next_cursor?: string;
}

export interface IndexerEnvelope<T> {
  data: T;
  meta: IndexerMeta;
}

export interface LeaderboardEntry {
  rank: number;
  user: string;
  trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  refunds: number;
  volume: string;
  payout: string;
  net_pnl: string;
  total_fees: string;
  win_rate_bps: number;
}

export interface IndexedPosition {
  market_id: number;
  position_id: number;
  user: string | null;
  direction: "up" | "down" | null;
  entry_price: string | null;
  collateral: string | null;
  expires_at: string | null;
  lifecycle_status: "open" | "settled" | "refunded";
  checkpoint_status: "er_only" | "base_observed" | "not_applicable";
  outcome: "won" | "lost" | "breakeven" | "refunded" | null;
  payout_amount: string | null;
  net_pnl: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

export type PositionStreamMessage =
  | { type: "snapshot"; positions: IndexedPosition[] }
  | { type: "upsert"; position: IndexedPosition };

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
  };
}

export class IndexerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "IndexerApiError";
  }
}

export function indexerApiUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_INDEXER_API_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function formatUsdcMinorUnits(minorUnits: string | null): string {
  if (minorUnits === null || !/^-?\d+$/.test(minorUnits)) return "—";
  const negative = minorUnits.startsWith("-");
  const digits = negative ? minorUnits.slice(1) : minorUnits;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-6, -4);
  return `${negative ? "−" : ""}$${whole}.${fraction}`;
}

export async function fetchLeaderboard(
  baseUrl: string,
  marketId: number,
  cursor?: string,
  signal?: AbortSignal,
): Promise<IndexerEnvelope<LeaderboardEntry[]>> {
  const query = new URLSearchParams({
    period: "all",
    market_id: marketId.toString(),
    limit: "5",
  });
  if (cursor) query.set("cursor", cursor);
  return request(`${baseUrl}/v1/leaderboards?${query}`, signal);
}

export async function fetchCompletedPositions(
  baseUrl: string,
  wallet: string,
  marketId: number,
  cursor?: string,
  signal?: AbortSignal,
): Promise<IndexerEnvelope<IndexedPosition[]>> {
  const query = new URLSearchParams({
    market_id: marketId.toString(),
    status: "closed",
    limit: "5",
  });
  if (cursor) query.set("cursor", cursor);
  return request(
    `${baseUrl}/v1/users/${encodeURIComponent(wallet)}/positions?${query}`,
    signal,
  );
}

export async function fetchPositions(
  baseUrl: string,
  wallet: string,
  marketId: number,
  cursor?: string,
  signal?: AbortSignal,
): Promise<IndexerEnvelope<IndexedPosition[]>> {
  const query = new URLSearchParams({
    market_id: marketId.toString(),
    limit: "100",
  });
  if (cursor) query.set("cursor", cursor);
  return request(
    `${baseUrl}/v1/users/${encodeURIComponent(wallet)}/positions?${query}`,
    signal,
  );
}

export async function fetchAllPositions(
  baseUrl: string,
  wallet: string,
  marketId: number,
  signal?: AbortSignal,
): Promise<IndexedPosition[]> {
  const positions: IndexedPosition[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPositions(baseUrl, wallet, marketId, cursor, signal);
    positions.push(...page.data);
    cursor = page.meta.next_cursor;
  } while (cursor);
  return positions;
}

export function positionStreamUrl(
  baseUrl: string,
  wallet: string,
  marketId: number,
): string {
  const url = new URL(
    `${baseUrl}/v1/users/${encodeURIComponent(wallet)}/positions/stream`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("market_id", marketId.toString());
  return url.toString();
}

export async function withCursorRecovery<T>(
  load: (cursor?: string) => Promise<IndexerEnvelope<T>>,
  cursor?: string,
): Promise<{ page: IndexerEnvelope<T>; restarted: boolean }> {
  try {
    return { page: await load(cursor), restarted: false };
  } catch (error) {
    if (cursor && error instanceof IndexerApiError && error.code === "cursor_stale") {
      return { page: await load(), restarted: true };
    }
    throw error;
  }
}

async function request<T>(
  url: string,
  signal?: AbortSignal,
): Promise<IndexerEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new IndexerApiError(
      "index_unavailable",
      "History is temporarily unavailable. Live play still works.",
      0,
    );
  }
  const body = (await response.json().catch(() => ({}))) as
    | IndexerEnvelope<T>
    | ErrorEnvelope;
  if (!response.ok) {
    const failure = body as ErrorEnvelope;
    throw new IndexerApiError(
      failure.error?.code ?? "index_unavailable",
      failure.error?.message ?? "History is temporarily unavailable. Live play still works.",
      response.status,
    );
  }
  return body as IndexerEnvelope<T>;
}
