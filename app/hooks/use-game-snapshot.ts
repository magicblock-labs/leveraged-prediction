"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import type { MarketSnapshot, SnapshotError } from "@/app/lib/domain";
import {
  applyOracleStreamUpdate,
  feedHealthAt,
  subscribeOraclePrice,
} from "@/app/lib/live/oracle-stream";
import { readClientLiveConfig } from "@/app/lib/live/client-config";
import { authorizeErAccess } from "@/app/lib/live/er-access";

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

export function useGameSnapshot(walletAddress: string | null) {
  const wallet = useWallet();
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [oracleError, setOracleError] = useState<{
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
        if (
          current &&
          stream &&
          currentKey === nextKey &&
          nextKey === stream.key &&
          Date.now() - stream.lastReceivedAt <= 5_000
        ) {
          const feed = feedHealthAt(stream.publishTime, Date.now());
          return {
            ...body,
            currentPrice: current.currentPrice,
            priceHistory: current.priceHistory,
            feedAgeSeconds: feed.ageSeconds,
            feedHealth: feed.health,
            capturedAt: current.capturedAt,
            notice: current.notice,
          };
        }
        return body;
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

  return {
    snapshot,
    error: snapshotError,
    oracleError: oracleError?.key === streamKey ? oracleError.message : null,
    refreshing,
    refresh,
  };
}
