"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { MarketSnapshot, Play } from "@/app/lib/domain";
import {
  CHART_PAST_MS,
  CHART_WINDOW_MS,
  createChartGeometry,
  nicePriceStep,
  type ChartViewport,
} from "@/app/lib/chart-geometry";
import { winProfitUsd } from "@/app/lib/position-presentation";

interface PriceArenaProps {
  snapshot: MarketSnapshot;
  plays: Play[];
  now: number;
  celebratingIds?: ReadonlySet<string>;
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

const TIME_TICK_OFFSETS = Array.from(
  { length: 4 },
  (_, index) => -CHART_PAST_MS + index * (CHART_WINDOW_MS / 3),
);

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

export function PriceArena({
  snapshot,
  plays,
  now,
  celebratingIds,
}: PriceArenaProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef({ snapshot, plays, now, celebratingIds });
  const [following, setFollowing] = useState(true);
  const [priceLabels, setPriceLabels] = useState<AxisLabel[]>([]);
  const [timeLabels, setTimeLabels] = useState(() =>
    TIME_TICK_OFFSETS.map(formatTimeOffset)
  );
  const followingRef = useRef(true);
  const viewportRef = useRef<ChartViewport>({ x: 0, y: 0 });

  useEffect(() => {
    dataRef.current = { snapshot, plays, now, celebratingIds };
  }, [snapshot, plays, now, celebratingIds]);

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
        const {
          snapshot: current,
          plays: currentPlays,
          celebratingIds: currentCelebrations,
        } = dataRef.current;
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
          geometry.plotLeft + ((offset + CHART_PAST_MS) / CHART_WINDOW_MS) * geometry.plotWidth
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

        // Entry lines persist through settlement while they remain in the visible time window.
        for (const play of currentPlays) {
          const settlingState = ["settling", "refunding"].includes(play.status);
          const celebrating = currentCelebrations?.has(play.id) ?? false;
          const color =
            play.status === "lost"
              ? theme.down
              : play.status === "won"
                ? theme.up
                : play.status === "breakeven" || play.status === "refunded" || settlingState
                  ? theme.wait
                  : play.direction === "up"
                    ? theme.up
                    : theme.down;
          const playY = geometry.y(play.entryPrice, view);
          graphics.moveTo(geometry.x(play.openedAt, view), playY)
            .lineTo(geometry.x(play.expiresAt, view), playY)
            .stroke({
              color,
              alpha: settlingState ? 0.5 : 0.85,
              width: play.status === "lost" || celebrating ? 3 : 2,
            });
          const resultX = geometry.x(play.expiresAt, view);
          graphics.circle(resultX, playY, 7).stroke({ color, alpha: 0.9, width: 2 });
          graphics.circle(resultX, playY, 2.5).fill({ color, alpha: 1 });

          if (celebrating) {
            const cycle = (frameAt % 900) / 900;
            const eased = 1 - Math.pow(1 - cycle, 3);
            for (let ring = 0; ring < 3; ring += 1) {
              const ringPhase = (cycle + ring / 3) % 1;
              graphics
                .circle(resultX, playY, 12 + ringPhase * 54)
                .stroke({
                  color: theme.up,
                  alpha: (1 - ringPhase) * 0.5,
                  width: 2,
                });
            }
            for (let particle = 0; particle < 14; particle += 1) {
              const angle = (particle / 14) * Math.PI * 2 + particle * 0.37;
              const distance = 16 + eased * (34 + (particle % 4) * 8);
              const particleX = resultX + Math.cos(angle) * distance;
              const particleY = playY + Math.sin(angle) * distance * 0.7;
              graphics
                .circle(particleX, particleY, 1.5 + (particle % 3) * 0.6)
                .fill({
                  color: particle % 4 === 0 ? theme.wait : theme.up,
                  alpha: 1 - cycle,
                });
            }
          }
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
  const celebratingPlay = plays.find(
    (play) => celebratingIds?.has(play.id) && play.status === "won",
  );
  const winProfit = celebratingPlay
    ? winProfitUsd(celebratingPlay)
    : null;

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
      {celebratingPlay ? (
        <div
          className="chart-win"
          key={celebratingPlay.id}
          role="status"
          aria-live="polite"
        >
          <div className="chart-win-burst" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => (
              <i key={index} style={{ "--burst-index": index } as CSSProperties} />
            ))}
          </div>
          <span>Round won</span>
          <strong className="num">
            {winProfit === null ? "Nice call" : `+$${winProfit.toFixed(2)}`}
          </strong>
          <small>
            {celebratingPlay.direction === "up" ? "▲ Up" : "▼ Down"} landed
          </small>
        </div>
      ) : null}
      <p className="sr-only">
        Current price {snapshot.currentPrice.toFixed(2)} dollars. The chart can be dragged to inspect history and never places a play.
      </p>
    </section>
  );
}
