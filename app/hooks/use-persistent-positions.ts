"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Play } from "@/app/lib/domain";
import {
  fetchAllPositions,
  indexerApiUrl,
  positionStreamUrl,
  type IndexedPosition,
  type PositionStreamMessage,
} from "@/app/lib/indexer/client";
import {
  mergeIndexedPosition,
  mergePersistentPositions,
  positionIdentity,
} from "@/app/lib/indexer/positions";

const WIN_ANIMATION_MS = 3_200;
const MAX_RECONNECT_DELAY_MS = 10_000;

interface PersistentPositionState {
  scope: string | null;
  direct: Map<string, Play>;
  indexed: Map<string, IndexedPosition>;
}

export function usePersistentPositions(
  wallet: string | null,
  marketId: number | null,
  directPositions: Play[],
  currentPrice: number,
  now: number,
) {
  const baseUrl = indexerApiUrl();
  const scope =
    wallet && marketId !== null ? `${wallet}:${marketId}:${baseUrl ?? ""}` : null;
  const [state, setState] = useState<PersistentPositionState>({
    scope: null,
    direct: new Map(),
    indexed: new Map(),
  });
  const [celebration, setCelebration] = useState<{
    scope: string | null;
    ids: Set<string>;
  }>({ scope: null, ids: new Set() });
  const winTimers = useRef(new Map<string, number>());
  const observedWins = useRef(new Set<string>());

  useEffect(() => {
    observedWins.current.clear();
    for (const timer of winTimers.current.values()) window.clearTimeout(timer);
    winTimers.current.clear();
  }, [scope]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setState((current) => {
        const scopeChanged = current.scope !== scope;
        const direct = scopeChanged
          ? new Map<string, Play>()
          : new Map(current.direct);
        let changed = scopeChanged;
        if (scope) {
          for (const play of directPositions) {
            if (!direct.has(play.id)) {
              direct.set(play.id, play);
              changed = true;
            }
          }
        }
        if (!changed) return current;
        return {
          scope,
          direct,
          indexed: scopeChanged ? new Map() : current.indexed,
        };
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [directPositions, scope]);

  useEffect(() => {
    if (!scope || !wallet || marketId === null || !baseUrl) return;
    const controller = new AbortController();
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 250;

    const mergeIndexed = (positions: IndexedPosition[]) => {
      for (const position of positions) {
        if (position.outcome === "won") {
          observedWins.current.add(
            positionIdentity(position.market_id, position.position_id),
          );
        }
      }
      setState((current) => {
        const indexed =
          current.scope === scope
            ? new Map(current.indexed)
            : new Map<string, IndexedPosition>();
        for (const position of positions) {
          const id = positionIdentity(position.market_id, position.position_id);
          indexed.set(id, mergeIndexedPosition(indexed.get(id), position));
        }
        return {
          scope,
          direct: current.scope === scope ? current.direct : new Map(),
          indexed,
        };
      });
    };

    const celebrateWin = (position: IndexedPosition) => {
      if (position.outcome !== "won") return;
      const id = positionIdentity(position.market_id, position.position_id);
      if (observedWins.current.has(id)) return;
      observedWins.current.add(id);
      setCelebration((current) => ({
        scope,
        ids: new Set(current.scope === scope ? current.ids : []).add(id),
      }));
      const existing = winTimers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        winTimers.current.delete(id);
        setCelebration((current) => {
          const next = new Set(current.scope === scope ? current.ids : []);
          next.delete(id);
          return { scope, ids: next };
        });
      }, WIN_ANIMATION_MS);
      winTimers.current.set(id, timer);
    };

    const connect = () => {
      if (!active) return;
      socket = new WebSocket(positionStreamUrl(baseUrl, wallet, marketId));
      socket.addEventListener("open", () => {
        reconnectDelay = 250;
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message: PositionStreamMessage;
        try {
          message = JSON.parse(event.data) as PositionStreamMessage;
        } catch {
          return;
        }
        if (message.type === "snapshot") {
          mergeIndexed(message.positions);
        } else if (message.type === "upsert") {
          celebrateWin(message.position);
          mergeIndexed([message.position]);
        }
      });
      socket.addEventListener("close", () => {
        if (!active) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      });
    };

    void fetchAllPositions(baseUrl, wallet, marketId, controller.signal)
      .then((positions) => {
        if (active) mergeIndexed(positions);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("[positions:indexer] initial fetch failed", error);
        }
      });
    connect();

    return () => {
      active = false;
      controller.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [baseUrl, marketId, scope, wallet]);

  useEffect(
    () => () => {
      for (const timer of winTimers.current.values()) window.clearTimeout(timer);
      winTimers.current.clear();
    },
    [],
  );

  const plays = useMemo(() => {
    if (!wallet || marketId === null) return [];
    if (state.scope !== scope) {
      return directPositions.map((play) => ({ ...play }));
    }
    return mergePersistentPositions(
      state.direct.values(),
      state.indexed.values(),
      currentPrice,
      now,
    );
  }, [currentPrice, directPositions, marketId, now, scope, state, wallet]);

  return {
    plays,
    celebratingIds: celebration.scope === scope ? celebration.ids : new Set<string>(),
  };
}
