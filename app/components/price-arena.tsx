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

interface Viewport {
  x: number;
  y: number;
}

interface TrailPoint {
  x: number;
  y: number;
  timestamp: number;
  rising: boolean;
}

const GRID_SIZE = 50;
const TIME_INTERVAL_SECONDS = 10;
const PRICE_INTERVAL_USD = 20;
const TRAIL_DURATION_MS = 3_000;
const MAX_TRAIL_POINTS = 100;

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
  const followingRef = useRef(true);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0 });
  const startTimeRef = useRef(snapshot.capturedAt);
  const initialPriceRef = useRef(snapshot.priceHistory[0]?.price ?? snapshot.currentPrice);

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
      let dragStartView: Viewport = { x: 0, y: 0 };
      let displayPrice = dataRef.current.snapshot.currentPrice;
      let previousDisplayPrice = displayPrice;
      let lastFrameAt = performance.now();
      let lastTrailAt = 0;
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
        const deltaMs = Math.min(frameAt - lastFrameAt, 100);
        lastFrameAt = frameAt;
        const width = app.screen.width;
        const height = app.screen.height;
        if (width < 20 || height < 20) return;
        const smoothing = 1 - Math.exp(-deltaMs / 150);
        displayPrice += (current.currentPrice - displayPrice) * smoothing;
        const elapsedSeconds = (Date.now() - startTimeRef.current) / 1_000;
        const priceWorldX = (elapsedSeconds / TIME_INTERVAL_SECONDS) * GRID_SIZE;
        const priceWorldY = -((displayPrice - initialPriceRef.current) / PRICE_INTERVAL_USD) * GRID_SIZE;

        if (followingRef.current && !dragging) {
          const targetX = priceWorldX - width / 2;
          const targetY = priceWorldY - height / 2;
          viewportRef.current.x += (targetX - viewportRef.current.x) * smoothing;
          viewportRef.current.y += (targetY - viewportRef.current.y) * smoothing;
        }

        const view = viewportRef.current;
        const x = (timestamp: number) => (
          ((timestamp - startTimeRef.current) / 1_000 / TIME_INTERVAL_SECONDS) * GRID_SIZE - view.x
        );
        const y = (price: number) => (
          -((price - initialPriceRef.current) / PRICE_INTERVAL_USD) * GRID_SIZE - view.y
        );

        if (frameAt - lastTrailAt >= 50) {
          trail.push({
            x: priceWorldX,
            y: priceWorldY,
            timestamp: Date.now(),
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

        const firstColumn = Math.floor(view.x / GRID_SIZE) - 1;
        const lastColumn = Math.ceil((view.x + width) / GRID_SIZE) + 1;
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const gridX = column * GRID_SIZE - view.x;
          graphics.moveTo(gridX, 0).lineTo(gridX, height).stroke({ color: 0x33506e, alpha: 0.22, width: 1 });
        }
        const firstRow = Math.floor((-height - view.y) / GRID_SIZE) - 1;
        const lastRow = Math.ceil(-view.y / GRID_SIZE) + 1;
        for (let row = firstRow; row <= lastRow; row += 1) {
          const gridY = -(row * GRID_SIZE) - view.y;
          graphics.moveTo(0, gridY).lineTo(width, gridY).stroke({ color: 0x33506e, alpha: 0.22, width: 1 });
        }

        for (const candle of candlesFrom(current.priceHistory)) {
          const candleX = x(candle.timestamp + 1_000);
          if (candleX < -10 || candleX > width + 10) continue;
          const up = candle.close >= candle.open;
          const color = up ? 0x28e7a7 : 0xff5b70;
          graphics.moveTo(candleX, y(candle.high)).lineTo(candleX, y(candle.low)).stroke({ color, alpha: 0.55, width: 1 });
          const bodyTop = Math.min(y(candle.open), y(candle.close));
          const bodyHeight = Math.max(Math.abs(y(candle.open) - y(candle.close)), 2);
          graphics.roundRect(candleX - 3, bodyTop, 6, bodyHeight, 1).fill({ color, alpha: 0.72 });
        }

        const trailNow = Date.now();
        for (let index = 1; index < trail.length; index += 1) {
          const previous = trail[index - 1];
          const point = trail[index];
          const age = trailNow - point.timestamp;
          if (age > TRAIL_DURATION_MS) continue;
          const alpha = (1 - age / TRAIL_DURATION_MS) * 0.7;
          const color = point.rising ? 0x28e7a7 : 0xff5b70;
          const startX = previous.x - view.x;
          const startY = previous.y - view.y;
          const endX = point.x - view.x;
          const endY = point.y - view.y;
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
          const trailY = y(play.entryPrice);
          graphics.moveTo(x(play.openedAt), trailY).lineTo(x(play.expiresAt), trailY).stroke({
            color,
            alpha: play.status === "active" ? 0.7 : 0.36,
            width: 2,
          });
          graphics.circle(x(play.expiresAt), trailY, 8).stroke({ color, alpha: 0.88, width: 2 });
          graphics.circle(x(play.expiresAt), trailY, 3).fill({ color, alpha: 0.92 });
        }

        const currentX = priceWorldX - view.x;
        const currentY = priceWorldY - view.y;
        graphics.moveTo(0, currentY).lineTo(width, currentY).stroke({ color: 0x67e8f9, alpha: 0.5, width: 1 });
        graphics.circle(currentX, currentY, 20).fill({ color: 0x67e8f9, alpha: 0.08 });
        graphics.circle(currentX, currentY, 12).fill({ color: 0x67e8f9, alpha: 0.16 });
        graphics.circle(currentX, currentY, 5).fill({ color: 0xd8fbff, alpha: 1 });
        graphics.circle(currentX, currentY, 12).stroke({ color: 0x67e8f9, alpha: 0.42, width: 2 });
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
      <div className="arena-labels" aria-hidden="true">
        <span>−20s</span><span>−10s</span><span>NOW</span><span>+10s</span><span>+20s</span>
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
