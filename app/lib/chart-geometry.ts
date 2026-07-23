import type { Play, PricePoint } from "@/app/lib/domain";

export const CHART_PAST_MS = 30_000;
export const CHART_FUTURE_MS = 15_000;
export const CHART_WINDOW_MS = CHART_PAST_MS + CHART_FUTURE_MS;
export const CHART_AXIS_WIDTH = 72;
export const CHART_RIGHT_PADDING = 20;

export interface ChartViewport {
  x: number;
  y: number;
}

export interface ChartGeometry {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  focusPrice: number;
  dollarsPerPixel: number;
  millisecondsPerPixel: number;
  x(timestamp: number, viewport?: ChartViewport): number;
  y(price: number, viewport?: ChartViewport): number;
  priceAt(screenY: number, viewport?: ChartViewport): number;
  timeOffsetAt(screenX: number, viewport?: ChartViewport): number;
}

function visiblePrices(
  history: PricePoint[],
  plays: Play[],
  currentPrice: number,
  now: number,
): number[] {
  return [
    currentPrice,
    ...history
      .filter((point) => point.timestamp >= now - CHART_PAST_MS)
      .map((point) => point.price),
    ...plays
      .filter((play) => play.refundAt >= now - CHART_PAST_MS)
      .map((play) => play.entryPrice),
  ].filter(Number.isFinite);
}

export function createChartGeometry(
  width: number,
  height: number,
  history: PricePoint[],
  plays: Play[],
  currentPrice: number,
  now: number,
): ChartGeometry {
  const plotLeft = Math.min(CHART_AXIS_WIDTH, Math.max(44, width * 0.18));
  const plotRight = Math.max(plotLeft + 40, width - CHART_RIGHT_PADDING);
  const mobile = width <= 980;
  const plotTop = 20;
  const plotBottom = Math.max(
    plotTop + 80,
    height - (mobile ? 34 : 180),
  );
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const prices = visiblePrices(history, plays, currentPrice, now);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const minimumRange = Math.max(20, currentPrice * 0.0005);
  const range = Math.max(minimumRange, (high - low) * 1.35);
  const focusPrice = (high + low) / 2;
  const dollarsPerPixel = range / plotHeight;
  const millisecondsPerPixel = CHART_WINDOW_MS / plotWidth;
  const liveX = plotLeft + CHART_PAST_MS / millisecondsPerPixel;
  const centerY = plotTop + plotHeight / 2;

  return {
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    focusPrice,
    dollarsPerPixel,
    millisecondsPerPixel,
    x: (timestamp, viewport = { x: 0, y: 0 }) =>
      liveX + (timestamp - now) / millisecondsPerPixel - viewport.x,
    y: (price, viewport = { x: 0, y: 0 }) =>
      centerY - (price - focusPrice) / dollarsPerPixel - viewport.y,
    priceAt: (screenY, viewport = { x: 0, y: 0 }) =>
      focusPrice - (screenY + viewport.y - centerY) * dollarsPerPixel,
    timeOffsetAt: (screenX, viewport = { x: 0, y: 0 }) =>
      (screenX + viewport.x - liveX) * millisecondsPerPixel,
  };
}

export function nicePriceStep(dollarsPerPixel: number, targetPixels = 70): number {
  const raw = Math.max(Number.EPSILON, dollarsPerPixel * targetPixels);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}
