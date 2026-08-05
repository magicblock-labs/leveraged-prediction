"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import type { MarketSnapshot, SnapshotError } from "@/app/lib/domain";
import {
  applyOracleStreamUpdate,
  feedHealthAt,
  mergeOraclePriceHistory,
  subscribeOraclePrice,
} from "@/app/lib/live/oracle-stream";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import { authorizeErAccess } from "@/app/lib/live/er-access";
import {
  refreshedMarketAdvanced,
  refreshedPositionsIncludeNewPlay,
} from "@/app/lib/live/play-reconciliation";
import {
  applyMarketStreamUpdate,
  applyPositionStreamUpdate,
  subscribeMarketState,
  subscribeUserPositions,
} from "@/app/lib/live/position-stream";

const configuredLivePollInterval = Number(
  process.env.NEXT_PUBLIC_LIVE_SNAPSHOT_INTERVAL_MS ?? "3000",
);
const livePollInterval = Number.isFinite(configuredLivePollInterval)
  ? Math.max(100, configuredLivePollInterval)
  : 3_000;

function oracleStreamKey(snapshot: MarketSnapshot): string | null {
  if (
    snapshot.mode !== "live" ||
    !snapshot.erEndpoint ||
    !snapshot.oracleAddress ||
    !snapshot.oracleFeedId
  ) return null;
  return `${snapshot.erEndpoint}:${snapshot.oracleAddress}:${snapshot.oracleFeedId}`;
}

function positionStreamKeyFor(
  snapshot: MarketSnapshot,
  walletAddress: string | null,
): string | null {
  const oracleKey = oracleStreamKey(snapshot);
  return oracleKey && walletAddress
    ? `${oracleKey}:${walletAddress}`
    : null;
}

export function useGameSnapshot(walletAddress: string | null) {
  const wallet = useWallet();
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [oracleError, setOracleError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [positionError, setPositionError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [marketError, setMarketError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const requestInFlight = useRef(false);
  const streamRef = useRef<{
    key: string;
    lastReceivedAt: number;
    publishTime: number;
  } | null>(null);
  const positionStreamRef = useRef<{
    key: string;
    lastReceivedAt: number;
  } | null>(null);
  const marketStreamRef = useRef<{
    key: string;
    lastReceivedAt: number;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const query = walletAddress ? `?wallet=${encodeURIComponent(walletAddress)}` : "";
      const response = await fetch(`/api/snapshot${query}`, { cache: "no-store" });
      const body = (await response.json()) as MarketSnapshot | SnapshotError;
      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : `Snapshot failed (${response.status})`);
      }
      setSnapshot((current) => {
        const stream = streamRef.current;
        const currentKey = current ? oracleStreamKey(current) : null;
        const nextKey = oracleStreamKey(body);
        const positionStream = positionStreamRef.current;
        const marketStream = marketStreamRef.current;
        const currentPositionKey = current
          ? positionStreamKeyFor(current, walletAddress)
          : null;
        const nextPositionKey = positionStreamKeyFor(body, walletAddress);
        const refreshedPositionsChanged = current
          ? refreshedPositionsIncludeNewPlay(current.plays, body.plays)
          : false;
        const refreshedMarketChanged = current
          ? refreshedMarketAdvanced(current.nextPositionNonce, body.nextPositionNonce)
          : false;
        let next = body;
        let preservedStream = false;
        if (current && currentKey === nextKey) {
          next = {
            ...next,
            priceHistory: mergeOraclePriceHistory(
              current.priceHistory,
              body.priceHistory,
              Date.now(),
            ),
          };
          preservedStream = true;
        }
        if (
          current &&
          stream &&
          currentKey === nextKey &&
          nextKey === stream.key &&
          Date.now() - stream.lastReceivedAt <= 5_000
        ) {
          const feed = feedHealthAt(stream.publishTime, Date.now());
          next = {
            ...next,
            currentPrice: current.currentPrice,
            currentRawPrice: current.currentRawPrice,
            feedAgeSeconds: feed.ageSeconds,
            feedHealth: feed.health,
            capturedAt: current.capturedAt,
            notice: current.notice,
          };
          preservedStream = true;
        }
        if (
          current &&
          positionStream &&
          currentPositionKey === nextPositionKey &&
          nextPositionKey === positionStream.key &&
          Date.now() - positionStream.lastReceivedAt <= 5_000 &&
          !refreshedPositionsChanged
        ) {
          next = {
            ...next,
            plays: current.plays,
            notice: current.notice,
          };
          preservedStream = true;
        }
        if (
          current &&
          marketStream &&
          currentKey === nextKey &&
          nextKey === marketStream.key &&
          Date.now() - marketStream.lastReceivedAt <= 5_000 &&
          !refreshedMarketChanged
        ) {
          next = {
            ...next,
            activePositions: current.activePositions,
            nextPositionNonce: current.nextPositionNonce,
            marketMode: current.marketMode,
            notice: current.notice,
          };
          preservedStream = true;
        }
        return preservedStream ? next : body;
      });
      setSnapshotError(null);
    } catch (cause) {
      setSnapshotError(cause instanceof Error ? cause.message : "Snapshot refresh failed");
    } finally {
      requestInFlight.current = false;
      setRefreshing(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(
      () => void refresh(),
      snapshot?.mode === "live" ? livePollInterval : 750,
    );
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [refresh, snapshot?.mode]);

  const streamKey = snapshot ? oracleStreamKey(snapshot) : null;
  const erEndpoint = snapshot?.erEndpoint;
  const oracleAddress = snapshot?.oracleAddress;
  const oracleFeedId = snapshot?.oracleFeedId;
  const programId = readClientLiveConfig().programId.toBase58();

  useEffect(() => {
    if (!streamKey || !erEndpoint || !oracleAddress || !oracleFeedId) {
      streamRef.current = null;
      return;
    }

    let active = true;
    let unsubscribe: () => void = () => undefined;
    streamRef.current = null;
    const connect = async () => {
      try {
        const config = readClientLiveConfig();
        let streamEndpoint = erEndpoint;
        let connection: Connection | undefined;
        if (config.erStreamRpcEndpoint) {
          if (!wallet.publicKey || !wallet.signMessage) {
            throw new Error("Connect a message-signing wallet for real-time updates");
          }
          const access = await authorizeErAccess(
            config.erStreamRpcEndpoint,
            config.erStreamWsEndpoint,
            wallet.publicKey,
            wallet.signMessage,
          );
          streamEndpoint = access.rpcEndpoint;
          connection = new Connection(access.rpcEndpoint, {
            commitment: "confirmed",
            wsEndpoint: access.wsEndpoint,
          });
        }
        if (!active) return;
        unsubscribe = subscribeOraclePrice(
          { erEndpoint: streamEndpoint, oracleAddress, oracleFeedId },
          (update) => {
            if (!active) return;
            streamRef.current = {
              key: streamKey,
              lastReceivedAt: update.receivedAt,
              publishTime: update.publishTime,
            };
            setSnapshot((current) => {
              if (!current || oracleStreamKey(current) !== streamKey) return current;
              return applyOracleStreamUpdate(current, update);
            });
            setOracleError((current) => current?.key === streamKey ? null : current);
          },
          (cause) => {
            if (!active) return;
            setOracleError({
              key: streamKey,
              message: cause instanceof Error ? cause.message : "Oracle websocket failed",
            });
          },
          connection,
        );
      } catch (cause) {
        if (!active) return;
        setOracleError({
          key: streamKey,
          message: cause instanceof Error ? cause.message : "Oracle websocket failed",
        });
      }
    };
    void connect();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [erEndpoint, oracleAddress, oracleFeedId, streamKey, wallet.publicKey, wallet.signMessage]);

  useEffect(() => {
    if (!streamKey || !erEndpoint || snapshot?.marketId === undefined) {
      marketStreamRef.current = null;
      return;
    }
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const connect = async () => {
      try {
        const config = readClientLiveConfig();
        let streamEndpoint = erEndpoint;
        let connection: Connection | undefined;
        if (config.erStreamRpcEndpoint) {
          if (!wallet.publicKey || !wallet.signMessage) {
            throw new Error("Connect a message-signing wallet for Market updates");
          }
          const access = await authorizeErAccess(
            config.erStreamRpcEndpoint,
            config.erStreamWsEndpoint,
            wallet.publicKey,
            wallet.signMessage,
          );
          streamEndpoint = access.rpcEndpoint;
          connection = new Connection(access.rpcEndpoint, {
            commitment: "confirmed",
            wsEndpoint: access.wsEndpoint,
          });
        }
        if (!active) return;
        unsubscribe = subscribeMarketState(
          {
            erEndpoint: streamEndpoint,
            programId,
            marketId: snapshot.marketId,
          },
          (update) => {
            if (!active) return;
            marketStreamRef.current = {
              key: streamKey,
              lastReceivedAt: update.receivedAt,
            };
            setSnapshot((current) => current
              ? applyMarketStreamUpdate(current, update)
              : current);
            setMarketError((current) => current?.key === streamKey ? null : current);
          },
          (cause) => {
            if (!active) return;
            setMarketError({
              key: streamKey,
              message: cause instanceof Error ? cause.message : "Market websocket failed",
            });
          },
          connection,
        );
      } catch (cause) {
        if (!active) return;
        setMarketError({
          key: streamKey,
          message: cause instanceof Error ? cause.message : "Market websocket failed",
        });
      }
    };
    void connect();
    return () => {
      active = false;
      if (marketStreamRef.current?.key === streamKey) {
        marketStreamRef.current = null;
      }
      unsubscribe();
    };
  }, [erEndpoint, programId, snapshot?.marketId, streamKey, wallet.publicKey, wallet.signMessage]);

  const positionStreamKey = snapshot
    ? positionStreamKeyFor(snapshot, wallet.publicKey?.toBase58() ?? null)
    : null;

  useEffect(() => {
    if (!positionStreamKey || !erEndpoint || !wallet.publicKey) {
      positionStreamRef.current = null;
      return;
    }
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const connect = async () => {
      try {
        const config = readClientLiveConfig();
        let streamEndpoint = erEndpoint;
        let connection: Connection | undefined;
        if (config.erStreamRpcEndpoint) {
          if (!wallet.signMessage) {
            throw new Error("Connect a message-signing wallet for position updates");
          }
          const access = await authorizeErAccess(
            config.erStreamRpcEndpoint,
            config.erStreamWsEndpoint,
            wallet.publicKey!,
            wallet.signMessage,
          );
          streamEndpoint = access.rpcEndpoint;
          connection = new Connection(access.rpcEndpoint, {
            commitment: "confirmed",
            wsEndpoint: access.wsEndpoint,
          });
        }
        if (!active) return;
        unsubscribe = subscribeUserPositions(
          {
            erEndpoint: streamEndpoint,
            programId,
            userAddress: wallet.publicKey!.toBase58(),
            marketId: snapshot?.marketId ?? config.marketId,
          },
          (update) => {
            if (!active) return;
            positionStreamRef.current = {
              key: positionStreamKey,
              lastReceivedAt: update.receivedAt,
            };
            setSnapshot((current) => current
              ? applyPositionStreamUpdate(current, update)
              : current);
            setPositionError((current) => current?.key === positionStreamKey ? null : current);
          },
          (cause) => {
            if (!active) return;
            setPositionError({
              key: positionStreamKey,
              message: cause instanceof Error ? cause.message : "Position websocket failed",
            });
          },
          connection,
        );
      } catch (cause) {
        if (!active) return;
        setPositionError({
          key: positionStreamKey,
          message: cause instanceof Error ? cause.message : "Position websocket failed",
        });
      }
    };
    void connect();
    return () => {
      active = false;
      if (positionStreamRef.current?.key === positionStreamKey) {
        positionStreamRef.current = null;
      }
      unsubscribe();
    };
  }, [erEndpoint, positionStreamKey, programId, snapshot?.marketId, wallet.publicKey, wallet.signMessage]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const stream = streamRef.current;
      if (!stream) return;
      setSnapshot((current) => {
        if (!current || oracleStreamKey(current) !== stream.key) return current;
        const feed = feedHealthAt(stream.publishTime, Date.now());
        if (
          current.feedHealth === feed.health &&
          Math.floor(current.feedAgeSeconds * 2) === Math.floor(feed.ageSeconds * 2)
        ) return current;
        return {
          ...current,
          feedAgeSeconds: feed.ageSeconds,
          feedHealth: feed.health,
          notice: feed.health === "live"
            ? "Live mode · oracle websocket connected"
            : "Live mode · waiting for the next oracle update",
        };
      });
    }, 500);
    return () => window.clearInterval(interval);
  }, []);

  const setWalletBalanceUsd = useCallback((walletBalanceUsd: number | null) => {
    setSnapshot((current) => current
      ? { ...current, walletBalanceUsd }
      : current);
  }, []);

  return {
    snapshot,
    error: snapshotError,
    oracleError: oracleError?.key === streamKey ? oracleError.message : null,
    marketError: marketError?.key === streamKey ? marketError.message : null,
    positionError: positionError?.key === positionStreamKey ? positionError.message : null,
    refreshing,
    refresh,
    setWalletBalanceUsd,
  };
}
