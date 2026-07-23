"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketSnapshot, Play } from "@/app/lib/domain";
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

interface AxisLabel {
  key: string;
  value: string;
  position: number;
}

interface ChartTheme {
  ink: number;
  mut: number;
  hair: number;
  up: number;
  down: number;
  wait: number;
}

const TIME_TICK_OFFSETS = [-20_000, -10_000, 0, 10_000, 20_000];

function cssColor(styles: CSSStyleDeclaration, name: string): number {
  const value = styles.getPropertyValue(name).trim();
  return value.startsWith("#") ? Number.parseInt(value.slice(1), 16) : 0x000000;
}

function readTheme(): ChartTheme {
  const styles = getComputedStyle(document.documentElement);
  return {
    ink: cssColor(styles, "--ink"),
    mut: cssColor(styles, "--mut"),
    hair: cssColor(styles, "--hair"),
    up: cssColor(styles, "--up"),
    down: cssColor(styles, "--down"),
    wait: cssColor(styles, "--wait"),
  };
}

function formatTimeOffset(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds === 0) return "now";
  return `${seconds > 0 ? "+" : "−"}${Math.abs(seconds)}s`;
}

export function PriceArena({ snapshot, plays, now }: PriceArenaProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef({ snapshot, plays, now });
  const [following, setFollowing] = useState(true);
  const [priceLabels, setPriceLabels] = useState<AxisLabel[]>([]);
  const [timeLabels, setTimeLabels] = useState(["−20s", "−10s", "now", "+10s", "+20s"]);
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
      let lastFrameAt = performance.now();
      let lastAxisAt = 0;
      let lastThemeAt = 0;
      let theme = readTheme();

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
        if (frameAt - lastThemeAt >= 500) {
          theme = readTheme();
          lastThemeAt = frameAt;
        }
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

        graphics.clear();

        // time gridlines
        const timeTickXs = TIME_TICK_OFFSETS.map((offset) =>
          geometry.plotLeft + ((offset + 20_000) / 40_000) * geometry.plotWidth
        );
        for (const tickX of timeTickXs) {
          graphics.moveTo(tickX, geometry.plotTop)
            .lineTo(tickX, geometry.plotBottom)
            .stroke({ color: theme.hair, alpha: 0.7, width: 1 });
        }

        // price gridlines + axis labels
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
            .stroke({ color: theme.hair, alpha: 0.7, width: 1 });
          nextPriceLabels.push({
            key: price.toFixed(8),
            value: `$${price.toLocaleString(undefined, {
              minimumFractionDigits: priceStep < 1 ? 2 : 0,
              maximumFractionDigits: priceStep < 1 ? 2 : 0,
            })}`,
            position: gridY,
          });
        }

        // price path (monochrome ink; color is reserved for positions)
        const path: { x: number; y: number }[] = [];
        for (const point of current.priceHistory) {
          const pointX = geometry.x(point.timestamp, view);
          if (pointX < geometry.plotLeft - 10 || pointX > geometry.plotRight + 10) continue;
          path.push({ x: pointX, y: geometry.y(point.price, view) });
        }
        const currentX = geometry.x(wallNow, view);
        const currentY = geometry.y(displayPrice, view);
        if (currentX >= geometry.plotLeft - 10 && currentX <= geometry.plotRight + 10) {
          path.push({ x: currentX, y: currentY });
        }
        if (path.length > 1) {
          // soft fill under the line
          graphics.moveTo(path[0].x, path[0].y);
          for (let index = 1; index < path.length; index += 1) graphics.lineTo(path[index].x, path[index].y);
          graphics.lineTo(path[path.length - 1].x, geometry.plotBottom)
            .lineTo(path[0].x, geometry.plotBottom)
            .closePath()
            .fill({ color: theme.ink, alpha: 0.05 });
          graphics.moveTo(path[0].x, path[0].y);
          for (let index = 1; index < path.length; index += 1) graphics.lineTo(path[index].x, path[index].y);
          graphics.stroke({ color: theme.ink, alpha: 1, width: 2, join: "round", cap: "round" });
        }

        // entry lines for open plays — the win/lose reference
        for (const play of currentPlays) {
          if (!["active", "settling", "refunding"].includes(play.status)) continue;
          const settlingState = play.status !== "active";
          const color = settlingState ? theme.wait : play.direction === "up" ? theme.up : theme.down;
          const playY = geometry.y(play.entryPrice, view);
          graphics.moveTo(geometry.x(play.openedAt, view), playY)
            .lineTo(geometry.x(play.expiresAt, view), playY)
            .stroke({ color, alpha: settlingState ? 0.5 : 0.85, width: 2 });
          graphics.circle(geometry.x(play.expiresAt, view), playY, 7).stroke({ color, alpha: 0.9, width: 2 });
          graphics.circle(geometry.x(play.expiresAt, view), playY, 2.5).fill({ color, alpha: 1 });
        }

        // live price marker
        graphics.moveTo(geometry.plotLeft, currentY)
          .lineTo(geometry.plotRight, currentY)
          .stroke({ color: theme.mut, alpha: 0.35, width: 1 });
        graphics.circle(currentX, currentY, 11).fill({ color: theme.ink, alpha: 0.08 });
        graphics.circle(currentX, currentY, 3.5).fill({ color: theme.ink, alpha: 1 });

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
    <section className="price-arena" ref={hostRef} aria-label="Live price chart">
      <div className="arena-canvas" ref={canvasRef} aria-hidden="true" />
      <div className="price-axis" aria-hidden="true">
        {priceLabels.map((label) => (
          <span key={label.key} style={{ top: label.position }}>{label.value}</span>
        ))}
      </div>
      <div className="arena-labels" aria-hidden="true">
        {timeLabels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}
      </div>
      <button className={`follow-button ${following ? "is-following" : ""}`} onClick={resetFollow} type="button">
        ↪ Return to live
      </button>
      <p className="sr-only">
        Current price {snapshot.currentPrice.toFixed(2)} dollars. The chart can be dragged to inspect history and never places a play.
      </p>
    </section>
  );
}
