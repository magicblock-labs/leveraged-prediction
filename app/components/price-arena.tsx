"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketSnapshot, Play, PricePoint } from "@/app/lib/domain";

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

export function PriceArena({ snapshot, plays, now }: PriceArenaProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef({ snapshot, plays, now });
  const [following, setFollowing] = useState(true);
  const panRef = useRef(0);

  useEffect(() => {
    dataRef.current = { snapshot, plays, now };
  }, [snapshot, plays, now]);

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
      let dragStart = 0;
      let dragStartPan = 0;
      const onPointerDown = (event: PointerEvent) => {
        dragging = true;
        dragStart = event.clientX;
        dragStartPan = panRef.current;
        app.canvas.setPointerCapture(event.pointerId);
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!dragging) return;
        const millisecondsPerPixel = 50_000 / Math.max(app.screen.width, 1);
        panRef.current = Math.max(0, dragStartPan + (event.clientX - dragStart) * millisecondsPerPixel);
        setFollowing(panRef.current < 150);
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
        const width = app.screen.width;
        const height = app.screen.height;
        if (width < 20 || height < 20) return;
        const plotTop = 28;
        const plotBottom = height - 34;
        const plotHeight = Math.max(plotBottom - plotTop, 1);
        const windowEnd = Date.now() + 4_000 - panRef.current;
        const windowStart = windowEnd - 50_000;
        const visible = current.priceHistory.filter(
          (point) => point.timestamp >= windowStart - 2_000 && point.timestamp <= windowEnd,
        );
        const reference = visible.length ? visible : current.priceHistory;
        const playPrices = currentPlays.map((play) => play.entryPrice);
        const prices = [...reference.map((point) => point.price), ...playPrices, current.currentPrice];
        const low = Math.min(...prices);
        const high = Math.max(...prices);
        const padding = Math.max((high - low) * 0.24, current.currentPrice * 0.00035);
        const minPrice = low - padding;
        const maxPrice = high + padding;
        const x = (timestamp: number) => ((timestamp - windowStart) / (windowEnd - windowStart)) * width;
        const y = (price: number) => plotTop + ((maxPrice - price) / (maxPrice - minPrice)) * plotHeight;

        graphics.clear();
        graphics.rect(0, 0, width, height).fill({ color: 0x07111f, alpha: 1 });
        graphics.circle(width * 0.2, height * 0.15, width * 0.36).fill({ color: 0x263f86, alpha: 0.08 });
        graphics.circle(width * 0.72, height * 0.64, width * 0.28).fill({ color: 0x0bd8c0, alpha: 0.035 });

        for (let column = 0; column <= 10; column += 1) {
          const gridX = (column / 10) * width;
          graphics.moveTo(gridX, 0).lineTo(gridX, height).stroke({ color: 0x33506e, alpha: 0.22, width: 1 });
        }
        for (let row = 0; row <= 8; row += 1) {
          const gridY = (row / 8) * height;
          graphics.moveTo(0, gridY).lineTo(width, gridY).stroke({ color: 0x33506e, alpha: 0.22, width: 1 });
        }

        for (const candle of candlesFrom(reference)) {
          const candleX = x(candle.timestamp + 1_000);
          if (candleX < -10 || candleX > width + 10) continue;
          const up = candle.close >= candle.open;
          const color = up ? 0x28e7a7 : 0xff5b70;
          graphics.moveTo(candleX, y(candle.high)).lineTo(candleX, y(candle.low)).stroke({ color, alpha: 0.55, width: 1 });
          const bodyTop = Math.min(y(candle.open), y(candle.close));
          const bodyHeight = Math.max(Math.abs(y(candle.open) - y(candle.close)), 2);
          graphics.roundRect(candleX - 3, bodyTop, 6, bodyHeight, 1).fill({ color, alpha: 0.72 });
        }

        if (reference.length > 1) {
          graphics.moveTo(x(reference[0].timestamp), y(reference[0].price));
          for (const point of reference.slice(1)) graphics.lineTo(x(point.timestamp), y(point.price));
          graphics.stroke({ color: 0x67e8f9, alpha: 0.8, width: 2 });
        }

        for (const play of currentPlays) {
          if (!["active", "settling", "refunding"].includes(play.status)) continue;
          const color = play.direction === "up" ? 0x28e7a7 : 0xff5b70;
          const trailY = y(play.entryPrice);
          graphics.moveTo(x(play.openedAt), trailY).lineTo(x(play.expiresAt), trailY).stroke({
            color,
            alpha: play.status === "active" ? 0.7 : 0.36,
            width: 2,
          });
          graphics.circle(x(play.expiresAt), trailY, 8).stroke({ color, alpha: 0.88, width: 2 });
          graphics.circle(x(play.expiresAt), trailY, 3).fill({ color, alpha: 0.92 });
        }

        const currentY = y(current.currentPrice);
        graphics.moveTo(0, currentY).lineTo(width, currentY).stroke({ color: 0x67e8f9, alpha: 0.5, width: 1 });
        graphics.circle(Math.min(x(current.capturedAt), width - 20), currentY, 5).fill({ color: 0xd8fbff, alpha: 1 });
        graphics.circle(Math.min(x(current.capturedAt), width - 20), currentY, 12).stroke({ color: 0x67e8f9, alpha: 0.42, width: 2 });
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
    panRef.current = 0;
    setFollowing(true);
  };

  return (
    <section className="price-arena" ref={hostRef} aria-label="Live BTC price arena">
      <div className="arena-canvas" ref={canvasRef} aria-hidden="true" />
      <div className="arena-labels" aria-hidden="true">
        <span>+40s</span><span>+30s</span><span>+20s</span><span>+10s</span><span>NOW</span>
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
