const COLLATERAL_SCALE = 1_000_000n;
const BPS = 10_000n;
const QUOTE_GUARD_BPS = 50n;
export const minimumOpenLiquidityMinor = 100_000_000_000n;

export interface LiquiditySnapshot {
  marketId: number;
  marketLabel: string;
  marketMode: "open" | "close-only";
  activePositions: number;
  totalShares: string;
  poolBalanceMinor: string;
  walletBalanceMinor: string | null;
  baseWalletBalanceMinor: string | null;
  erWalletBalanceMinor: string | null;
  userShares: string;
  pendingWithdrawalShares: string;
  pendingMinAssetsOutMinor: string;
  currentValueMinor: string;
  userLiquidityStatus: "not-created" | "needs-delegation" | "ready";
  erEndpoint: string;
  collateralMint: string;
  capturedAt: number;
}

export interface LiquiditySnapshotError {
  error: string;
  code: "LIVE_UNAVAILABLE" | "INVALID_REQUEST";
}

export function parseUsdcInput(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const minor = BigInt(whole) * COLLATERAL_SCALE +
    BigInt(fraction.padEnd(6, "0"));
  return minor > 0n ? minor : null;
}

export function formatUsdcMinor(amount: bigint): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = (absolute / COLLATERAL_SCALE).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % COLLATERAL_SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${grouped}.${fraction.slice(0, 2)}`;
}

export function formatShares(shares: bigint): string {
  return shares.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function assetsForShares(
  shares: bigint,
  poolBalance: bigint,
  totalShares: bigint,
): bigint {
  if (shares <= 0n || poolBalance < 0n || totalShares < shares) return 0n;
  return shares * poolBalance / totalShares;
}

export function sharesForDeposit(
  amount: bigint,
  poolBalance: bigint,
  totalShares: bigint,
): bigint {
  if (amount <= 0n || poolBalance < 0n || totalShares < 0n) return 0n;
  if (totalShares === 0n) return poolBalance + amount;
  if (poolBalance === 0n) return 0n;
  return amount * totalShares / poolBalance;
}

export function sharesForAssetsRoundUp(
  assets: bigint,
  poolBalance: bigint,
  totalShares: bigint,
): bigint {
  if (assets <= 0n || poolBalance <= 0n || totalShares <= 0n) return 0n;
  return (assets * totalShares + poolBalance - 1n) / poolBalance;
}

export function maximumRemovableShares(
  userShares: bigint,
  poolBalance: bigint,
  totalShares: bigint,
  marketMode: "open" | "close-only",
): bigint {
  if (userShares <= 0n || poolBalance <= 0n || totalShares <= 0n) return 0n;
  if (marketMode === "close-only") return userShares;
  if (poolBalance <= minimumOpenLiquidityMinor) return 0n;
  const marketMaximum =
    (poolBalance - minimumOpenLiquidityMinor) * totalShares / poolBalance;
  return marketMaximum < userShares ? marketMaximum : userShares;
}

export function guardedMinimum(value: bigint): bigint {
  return value * (BPS - QUOTE_GUARD_BPS) / BPS;
}

export const collateralScale = COLLATERAL_SCALE;
