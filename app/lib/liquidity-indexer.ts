export type LiquidityIndexerStatus =
  | "disabled"
  | "loading"
  | "ready"
  | "stale"
  | "unavailable";

export interface IndexedLiquidityMarket {
  marketMode: "open" | "close-only" | null;
  totalShares: string | null;
  activePositions: number | null;
  poolBalanceMinor: string | null;
}

export interface LiquidityIndexerResult {
  market: IndexedLiquidityMarket;
  depositedMinor: string | null;
  indexedShares: string | null;
  stale: boolean;
  asOf: string;
}

export interface IndexedLiquidityEvent {
  eventKind:
    | "deposit"
    | "withdrawal_requested"
    | "withdrawal_cancelled"
    | "withdrawal_executed";
  assets: string | null;
  shares: string;
}

interface IndexerMeta {
  asOf: string;
  stale: boolean;
  nextCursor?: string;
}

interface IndexerEnvelope<T> {
  data: T;
  meta: IndexerMeta;
}

const MAX_LIQUIDITY_PAGES = 100;
const LIQUIDITY_EVENT_KINDS = new Set<IndexedLiquidityEvent["eventKind"]>([
  "deposit",
  "withdrawal_requested",
  "withdrawal_cancelled",
  "withdrawal_executed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnsigned(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Indexer returned an invalid ${field}`);
  }
  return value;
}

function readNullableUnsigned(value: unknown, field: string): string | null {
  return value === null ? null : readUnsigned(value, field);
}

function readNullableCount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Indexer returned an invalid ${field}`);
  }
  return Number(value);
}

function readMarketMode(value: unknown): "open" | "close-only" | null {
  if (value === null) return null;
  if (value === "open") return "open";
  if (value === "close_only" || value === "close-only") return "close-only";
  throw new Error("Indexer returned an invalid market mode");
}

function parseMeta(value: unknown): IndexerMeta {
  if (
    !isRecord(value) ||
    typeof value.as_of !== "string" ||
    !value.as_of ||
    typeof value.stale !== "boolean"
  ) {
    throw new Error("Indexer returned invalid response metadata");
  }
  if (
    value.next_cursor !== undefined &&
    typeof value.next_cursor !== "string"
  ) {
    throw new Error("Indexer returned an invalid pagination cursor");
  }
  return {
    asOf: value.as_of,
    stale: value.stale,
    nextCursor: value.next_cursor,
  };
}

function parseMarket(
  value: unknown,
  expectedMarketId: number,
): IndexedLiquidityMarket {
  if (!isRecord(value) || value.market_id !== expectedMarketId) {
    throw new Error("Indexer returned an invalid liquidity market");
  }
  return {
    marketMode: readMarketMode(value.mode),
    totalShares: readNullableUnsigned(value.total_shares, "total shares"),
    activePositions: readNullableCount(value.active_positions, "active positions"),
    poolBalanceMinor: readNullableUnsigned(value.pool_balance, "pool balance"),
  };
}

function parseLiquidityEvent(
  value: unknown,
  expectedMarketId: number,
  expectedWallet: string,
): IndexedLiquidityEvent {
  if (
    !isRecord(value) ||
    value.market_id !== expectedMarketId ||
    value.user !== expectedWallet ||
    typeof value.event_kind !== "string" ||
    !LIQUIDITY_EVENT_KINDS.has(
      value.event_kind as IndexedLiquidityEvent["eventKind"],
    )
  ) {
    throw new Error("Indexer returned an invalid liquidity event");
  }
  return {
    eventKind: value.event_kind as IndexedLiquidityEvent["eventKind"],
    assets: readNullableUnsigned(value.assets, "liquidity assets"),
    shares: readUnsigned(value.shares, "liquidity shares"),
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
      : "Liquidity history is temporarily unavailable";
    throw new Error(message);
  }
  if (!isRecord(body)) throw new Error("Indexer returned an invalid response");
  return {
    data: parseData(body.data),
    meta: parseMeta(body.meta),
  };
}

async function fetchIndexedMarket(
  baseUrl: string,
  marketId: number,
  signal: AbortSignal,
): Promise<IndexerEnvelope<IndexedLiquidityMarket>> {
  return request(
    `${baseUrl}/v1/markets/${marketId}/summary`,
    (value) => parseMarket(value, marketId),
    signal,
  );
}

async function fetchLiquidityHistory(
  baseUrl: string,
  marketId: number,
  wallet: string,
  signal: AbortSignal,
): Promise<{
  events: IndexedLiquidityEvent[];
  stale: boolean;
  asOf: string;
}> {
  const events: IndexedLiquidityEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let stale = false;
  let asOf = "";

  for (let page = 0; page < MAX_LIQUIDITY_PAGES; page += 1) {
    const query = new URLSearchParams({
      market_id: marketId.toString(),
      limit: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await request(
      `${baseUrl}/v1/users/${encodeURIComponent(wallet)}/liquidity?${query}`,
      (value) => {
        if (!Array.isArray(value)) {
          throw new Error("Indexer returned invalid liquidity history");
        }
        return value.map((event) =>
          parseLiquidityEvent(event, marketId, wallet)
        );
      },
      signal,
    );
    events.push(...response.data);
    stale ||= response.meta.stale;
    asOf = response.meta.asOf;
    cursor = response.meta.nextCursor;
    if (!cursor) return { events, stale, asOf };
    if (seenCursors.has(cursor)) {
      throw new Error("Indexer repeated a liquidity cursor");
    }
    seenCursors.add(cursor);
  }

  throw new Error("Liquidity history exceeds the supported page limit");
}

export function summarizeLiquidityHistory(
  newestFirstEvents: IndexedLiquidityEvent[],
): { depositedMinor: string; indexedShares: string } {
  let deposited = 0n;
  let shares = 0n;

  for (const event of [...newestFirstEvents].reverse()) {
    const eventShares = BigInt(event.shares);
    if (event.eventKind === "deposit") {
      if (event.assets === null) {
        throw new Error("Indexed deposit is missing its asset amount");
      }
      shares += eventShares;
      deposited += BigInt(event.assets);
      continue;
    }
    if (event.eventKind !== "withdrawal_executed") continue;
    if (eventShares > shares) {
      throw new Error("Indexed liquidity history is incomplete");
    }
    if (eventShares === shares) {
      deposited = 0n;
      shares = 0n;
      continue;
    }
    const remainingShares = shares - eventShares;
    deposited = shares === 0n ? 0n : deposited * remainingShares / shares;
    shares = remainingShares;
  }

  return {
    depositedMinor: deposited.toString(),
    indexedShares: shares.toString(),
  };
}

export function liquidityIndexerApiUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_INDEXER_API_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export async function fetchLiquidityIndexerResult(
  baseUrl: string,
  marketId: number,
  wallet: string | null,
  signal: AbortSignal,
): Promise<LiquidityIndexerResult> {
  const [market, history] = await Promise.all([
    fetchIndexedMarket(baseUrl, marketId, signal),
    wallet
      ? fetchLiquidityHistory(baseUrl, marketId, wallet, signal)
      : Promise.resolve(null),
  ]);
  const historySummary = history
    ? summarizeLiquidityHistory(history.events)
    : null;

  return {
    market: market.data,
    depositedMinor: historySummary?.depositedMinor ?? null,
    indexedShares: historySummary?.indexedShares ?? null,
    stale: market.meta.stale || (history?.stale ?? false),
    asOf: history?.asOf || market.meta.asOf,
  };
}
