"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketSnapshot, Play, PricePoint } from "@/app/lib/domain";
import {
  createChartGeometry,
  nicePriceStep,
  type ChartViewport,
} from "@/app/lib/chart-geometry";

interface PriceArenaProps {
  snapshot: MarketSnapshot;
  plays: Play[];
  now: number;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface TrailPoint {
  price: number;
  timestamp: number;
  rising: boolean;
}

interface AxisLabel {
  key: string;
  value: string;
  position: number;
}

const TRAIL_DURATION_MS = 3_000;
const MAX_TRAIL_POINTS = 100;
const TIME_TICK_OFFSETS = [-20_000, -10_000, 0, 10_000, 20_000];

function candlesFrom(points: PricePoint[]): Candle[] {
  const buckets = new Map<number, PricePoint[]>();
  for (const point of points) {
    const key = Math.floor(point.timestamp / 2_000) * 2_000;
    buckets.set(key, [...(buckets.get(key) ?? []), point]);
  }
  return [...buckets.entries()].map(([timestamp, bucket]) => ({
    timestamp,
    open: bucket[0].price,
    high: Math.max(...bucket.map((point) => point.price)),
    low: Math.min(...bucket.map((point) => point.price)),
    close: bucket[bucket.length - 1].price,
  }));
}

function formatTimeOffset(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds === 0) return "NOW";
  return `${seconds > 0 ? "+" : "−"}${Math.abs(seconds)}s`;
}

export function PriceArena({ snapshot, plays, now }: PriceArenaProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef({ snapshot, plays, now });
  const [following, setFollowing] = useState(true);
  const [priceLabels, setPriceLabels] = useState<AxisLabel[]>([]);
  const [timeLabels, setTimeLabels] = useState(["−20s", "−10s", "NOW", "+10s", "+20s"]);
  const followingRef = useRef(true);
  const viewportRef = useRef<ChartViewport>({ x: 0, y: 0 });

  useEffect(() => {
    dataRef.current = { snapshot, plays, now };
  }, [snapshot, plays, now]);

  useEffect(() => {
    followingRef.current = following;
  }, [following]);

  useEffect(() => {
    const host = hostRef.current;
    const container = canvasRef.current;
    if (!host || !container) return;

    let mounted = true;
    let cleanup = () => undefined;

    void import("pixi.js").then(async ({ Application, Graphics }) => {
      if (!mounted) return;
      const app = new Application();
      await app.init({
        resizeTo: host,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        backgroundAlpha: 0,
      });
      if (!mounted) {
        app.destroy(true);
        return;
      }
      container.replaceChildren(app.canvas);
      const graphics = new Graphics();
      app.stage.addChild(graphics);

      let dragging = false;
      let dragStart = { x: 0, y: 0 };
      let dragStartView: ChartViewport = { x: 0, y: 0 };
      let displayPrice = dataRef.current.snapshot.currentPrice;
      let previousDisplayPrice = displayPrice;
      let lastFrameAt = performance.now();
      let lastTrailAt = 0;
      let lastAxisAt = 0;
      const trail: TrailPoint[] = [];

      const onPointerDown = (event: PointerEvent) => {
        dragging = true;
        dragStart = { x: event.clientX, y: event.clientY };
        dragStartView = { ...viewportRef.current };
        app.canvas.setPointerCapture(event.pointerId);
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!dragging) return;
        viewportRef.current = {
          x: dragStartView.x - (event.clientX - dragStart.x),
          y: dragStartView.y - (event.clientY - dragStart.y),
        };
        followingRef.current = false;
        setFollowing(false);
      };
      const onPointerUp = () => {
        dragging = false;
      };
      app.canvas.addEventListener("pointerdown", onPointerDown);
      app.canvas.addEventListener("pointermove", onPointerMove);
      app.canvas.addEventListener("pointerup", onPointerUp);
      app.canvas.addEventListener("pointercancel", onPointerUp);

      const draw = () => {
        const { snapshot: current, plays: currentPlays } = dataRef.current;
        const frameAt = performance.now();
        const wallNow = Date.now();
        const deltaMs = Math.min(frameAt - lastFrameAt, 100);
        lastFrameAt = frameAt;
        const width = app.screen.width;
        const height = app.screen.height;
        if (width < 20 || height < 20) return;
        const smoothing = 1 - Math.exp(-deltaMs / 150);
        displayPrice += (current.currentPrice - displayPrice) * smoothing;
        if (followingRef.current && !dragging) {
          viewportRef.current.x += (0 - viewportRef.current.x) * smoothing;
          viewportRef.current.y += (0 - viewportRef.current.y) * smoothing;
        }
        const view = viewportRef.current;
        const geometry = createChartGeometry(
          width,
          height,
          current.priceHistory,
          currentPlays,
          displayPrice,
          wallNow,
        );

        if (frameAt - lastTrailAt >= 50) {
          trail.push({
            price: displayPrice,
            timestamp: wallNow,
            rising: displayPrice >= previousDisplayPrice,
          });
          if (trail.length > MAX_TRAIL_POINTS) trail.shift();
          lastTrailAt = frameAt;
          previousDisplayPrice = displayPrice;
        }

        graphics.clear();
        graphics.rect(0, 0, width, height).fill({ color: 0x07111f, alpha: 1 });
        graphics.circle(width * 0.2, height * 0.15, width * 0.36).fill({ color: 0x263f86, alpha: 0.08 });
        graphics.circle(width * 0.72, height * 0.64, width * 0.28).fill({ color: 0x0bd8c0, alpha: 0.035 });
        graphics.rect(0, geometry.plotTop, geometry.plotLeft, geometry.plotHeight).fill({ color: 0x07101d, alpha: 0.9 });
        graphics.moveTo(geometry.plotLeft, geometry.plotTop)
          .lineTo(geometry.plotLeft, geometry.plotBottom)
          .stroke({ color: 0x476783, alpha: 0.42, width: 1 });

        const timeTickXs = TIME_TICK_OFFSETS.map((offset) =>
          geometry.plotLeft + ((offset + 20_000) / 40_000) * geometry.plotWidth
        );
        for (const tickX of timeTickXs) {
          graphics.moveTo(tickX, geometry.plotTop)
            .lineTo(tickX, geometry.plotBottom)
            .stroke({ color: 0x33506e, alpha: 0.26, width: 1 });
        }

        const priceStep = nicePriceStep(geometry.dollarsPerPixel);
        const topPrice = geometry.priceAt(geometry.plotTop, view);
        const bottomPrice = geometry.priceAt(geometry.plotBottom, view);
        const firstPrice = Math.ceil(Math.min(topPrice, bottomPrice) / priceStep) * priceStep;
        const nextPriceLabels: AxisLabel[] = [];
        for (
          let price = firstPrice;
          price <= Math.max(topPrice, bottomPrice) + priceStep / 2;
          price += priceStep
        ) {
          const gridY = geometry.y(price, view);
          if (gridY < geometry.plotTop - 1 || gridY > geometry.plotBottom + 1) continue;
          graphics.moveTo(geometry.plotLeft, gridY)
            .lineTo(geometry.plotRight, gridY)
            .stroke({ color: 0x33506e, alpha: 0.24, width: 1 });
          nextPriceLabels.push({
            key: price.toFixed(8),
            value: `$${price.toLocaleString(undefined, {
              minimumFractionDigits: priceStep < 1 ? 2 : 0,
              maximumFractionDigits: priceStep < 1 ? 2 : 0,
            })}`,
            position: gridY,
          });
        }

        for (const candle of candlesFrom(current.priceHistory)) {
          const candleX = geometry.x(candle.timestamp + 1_000, view);
          if (candleX < geometry.plotLeft - 10 || candleX > geometry.plotRight + 10) continue;
          const up = candle.close >= candle.open;
          const color = up ? 0x28e7a7 : 0xff5b70;
          graphics.moveTo(candleX, geometry.y(candle.high, view))
            .lineTo(candleX, geometry.y(candle.low, view))
            .stroke({ color, alpha: 0.55, width: 1 });
          const openY = geometry.y(candle.open, view);
          const closeY = geometry.y(candle.close, view);
          graphics.roundRect(
            candleX - 3,
            Math.min(openY, closeY),
            6,
            Math.max(Math.abs(openY - closeY), 2),
            1,
          ).fill({ color, alpha: 0.72 });
        }

        for (let index = 1; index < trail.length; index += 1) {
          const previous = trail[index - 1];
          const point = trail[index];
          const age = wallNow - point.timestamp;
          if (age > TRAIL_DURATION_MS) continue;
          const alpha = (1 - age / TRAIL_DURATION_MS) * 0.7;
          const color = point.rising ? 0x28e7a7 : 0xff5b70;
          const startX = geometry.x(previous.timestamp, view);
          const startY = geometry.y(previous.price, view);
          const endX = geometry.x(point.timestamp, view);
          const endY = geometry.y(point.price, view);
          graphics.moveTo(startX, startY).lineTo(endX, endY).stroke({
            color,
            alpha: alpha * 0.22,
            width: 10,
            cap: "round",
          });
          graphics.moveTo(startX, startY).lineTo(endX, endY).stroke({
            color,
            alpha,
            width: 3,
            cap: "round",
          });
        }

        for (const play of currentPlays) {
          if (!["active", "settling", "refunding"].includes(play.status)) continue;
          const color = play.direction === "up" ? 0x28e7a7 : 0xff5b70;
          const playY = geometry.y(play.entryPrice, view);
          graphics.moveTo(geometry.x(play.openedAt, view), playY)
            .lineTo(geometry.x(play.expiresAt, view), playY)
            .stroke({
              color,
              alpha: play.status === "active" ? 0.7 : 0.36,
              width: 2,
            });
          graphics.circle(geometry.x(play.expiresAt, view), playY, 8).stroke({ color, alpha: 0.88, width: 2 });
          graphics.circle(geometry.x(play.expiresAt, view), playY, 3).fill({ color, alpha: 0.92 });
        }

        const currentX = geometry.x(wallNow, view);
        const currentY = geometry.y(displayPrice, view);
        graphics.moveTo(geometry.plotLeft, currentY)
          .lineTo(geometry.plotRight, currentY)
          .stroke({ color: 0x67e8f9, alpha: 0.5, width: 1 });
        graphics.circle(currentX, currentY, 20).fill({ color: 0x67e8f9, alpha: 0.08 });
        graphics.circle(currentX, currentY, 12).fill({ color: 0x67e8f9, alpha: 0.16 });
        graphics.circle(currentX, currentY, 5).fill({ color: 0xd8fbff, alpha: 1 });
        graphics.circle(currentX, currentY, 12).stroke({ color: 0x67e8f9, alpha: 0.42, width: 2 });

        if (frameAt - lastAxisAt >= 250) {
          setPriceLabels(nextPriceLabels);
          setTimeLabels(timeTickXs.map((tickX) =>
            formatTimeOffset(geometry.timeOffsetAt(tickX, view))
          ));
          lastAxisAt = frameAt;
        }
      };

      app.ticker.add(draw);
      cleanup = () => {
        app.canvas.removeEventListener("pointerdown", onPointerDown);
        app.canvas.removeEventListener("pointermove", onPointerMove);
        app.canvas.removeEventListener("pointerup", onPointerUp);
        app.canvas.removeEventListener("pointercancel", onPointerUp);
        app.destroy(true, { children: true });
      };
    });

    return () => {
      mounted = false;
      cleanup();
    };
  }, []);

  const resetFollow = () => {
    followingRef.current = true;
    setFollowing(true);
  };

  return (
    <section className="price-arena" ref={hostRef} aria-label="Live BTC price arena">
      <div className="arena-canvas" ref={canvasRef} aria-hidden="true" />
      <div className="price-axis" aria-hidden="true">
        {priceLabels.map((label) => (
          <span key={label.key} style={{ top: label.position }}>{label.value}</span>
        ))}
      </div>
      <div className="arena-labels" aria-hidden="true">
        {timeLabels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}
      </div>
      <div className="price-reticle" aria-live="polite">
        <span>LIVE PRICE</span>
        <strong>${snapshot.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>
      <button className={`follow-button ${following ? "is-following" : ""}`} onClick={resetFollow} type="button">
        {following ? "● FOLLOWING" : "↪ RETURN LIVE"}
      </button>
      <p className="sr-only">
        Current BTC price {snapshot.currentPrice.toFixed(2)} dollars. The chart can be dragged to inspect history and never places a play.
      </p>
    </section>
  );
}
