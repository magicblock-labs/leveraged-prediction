use std::{
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use leveraged_prediction_storage::Storage;
use serde::Serialize;
use solana_client::{
    nonblocking::pubsub_client::PubsubClient,
    rpc_config::{RpcTransactionLogsConfig, RpcTransactionLogsFilter},
};
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use tokio::sync::{oneshot, watch};
use url::Url;

use crate::{
    ingest, projections::leaderboards, smoke, sources::router::RouterClient,
    sources::websocket_url, ProbeConfig,
};

const SUBSCRIPTION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub bind: SocketAddr,
    pub reconnect_delay: Duration,
    pub route_refresh_interval: Duration,
    pub refresh_interval: Duration,
    pub maximum_staleness: Duration,
    pub catchup_limit: usize,
    pub v2_min_slot: u64,
    pub database_pool_size: u32,
    pub once: bool,
}

#[derive(Clone, Debug, Serialize)]
struct RuntimeSnapshot {
    started_at: DateTime<Utc>,
    last_attempt_at: Option<DateTime<Utc>>,
    last_success_at: Option<DateTime<Utc>>,
    subscription_connected: bool,
    connection_sessions_total: u64,
    reconnects_total: u64,
    failures_total: u64,
    notifications_received_total: u64,
    transactions_scanned_total: u64,
    events_applied_total: u64,
    last_cursor_found: bool,
    last_source_high_water_mark: Option<i64>,
    last_refresh_duration_ms: u64,
    last_error: Option<String>,
}

impl RuntimeSnapshot {
    fn new() -> Self {
        Self {
            started_at: Utc::now(),
            last_attempt_at: None,
            last_success_at: None,
            subscription_connected: false,
            connection_sessions_total: 0,
            reconnects_total: 0,
            failures_total: 0,
            notifications_received_total: 0,
            transactions_scanned_total: 0,
            events_applied_total: 0,
            last_cursor_found: false,
            last_source_high_water_mark: None,
            last_refresh_duration_ms: 0,
            last_error: None,
        }
    }
}

#[derive(Clone)]
struct HealthState {
    runtime: Arc<RwLock<RuntimeSnapshot>>,
    storage: Storage,
    maximum_staleness: Duration,
}

#[derive(Debug, Serialize)]
struct Health {
    status: &'static str,
    last_success_at: Option<DateTime<Utc>>,
    stale: bool,
    subscription_connected: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct DeadLetterMetrics {
    dead_letters: i64,
    attempts: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum SessionExit {
    Shutdown,
    RouteChanged,
    StreamEnded,
}

pub async fn run(chain: ProbeConfig, database_url: &str, config: RuntimeConfig) -> Result<()> {
    validate_config(&config)?;
    let storage =
        Storage::connect_with_max_connections(database_url, config.database_pool_size).await?;
    storage.require_current_schema().await?;
    let runtime = Arc::new(RwLock::new(RuntimeSnapshot::new()));
    let health_state = HealthState {
        runtime: Arc::clone(&runtime),
        storage: storage.clone(),
        maximum_staleness: config.maximum_staleness,
    };
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("failed to bind indexer health listener {}", config.bind))?;
    let local_addr = listener.local_addr()?;
    let (health_shutdown_tx, health_shutdown_rx) = oneshot::channel::<()>();
    let health_server = tokio::spawn(async move {
        axum::serve(listener, health_router(health_state))
            .with_graceful_shutdown(async {
                let _ = health_shutdown_rx.await;
            })
            .await
    });
    let (signal_tx, mut signal_rx) = watch::channel(false);
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            let _ = signal_tx.send(true);
        }
    });
    log_json(
        "indexer_started",
        serde_json::json!({
            "health_bind": local_addr,
            "network": chain.network.as_str(),
            "program_id": chain.program_id.to_string(),
            "market_id": chain.market_id,
            "v2_min_slot": config.v2_min_slot,
            "ingestion": "logs_subscribe",
        }),
    );

    let mut reconnect = false;
    loop {
        if *signal_rx.borrow() {
            break;
        }
        {
            let mut state = runtime.write().expect("runtime metrics lock poisoned");
            state.last_attempt_at = Some(Utc::now());
            state.connection_sessions_total = state.connection_sessions_total.saturating_add(1);
            if reconnect {
                state.reconnects_total = state.reconnects_total.saturating_add(1);
            }
        }
        let result =
            subscription_session(&chain, &storage, &config, &runtime, &mut signal_rx).await;
        mark_disconnected(&runtime);
        match result {
            Ok(SessionExit::Shutdown) => break,
            Ok(SessionExit::RouteChanged) => {
                log_json(
                    "indexer_subscription_restarting",
                    serde_json::json!({"reason": "route_changed"}),
                );
            }
            Ok(SessionExit::StreamEnded) => {
                record_failure(&runtime, "ER logsSubscribe stream ended".to_owned());
                log_json(
                    "indexer_subscription_restarting",
                    serde_json::json!({"reason": "stream_ended"}),
                );
            }
            Err(error) => {
                record_failure(&runtime, error.to_string());
                log_json(
                    "indexer_subscription_failed",
                    serde_json::json!({"error": error.to_string()}),
                );
            }
        }
        if config.once {
            break;
        }
        reconnect = true;
        tokio::select! {
            changed = signal_rx.changed() => {
                if changed.is_err() || *signal_rx.borrow() {
                    break;
                }
            }
            () = tokio::time::sleep(config.reconnect_delay) => {}
        }
    }

    log_json("indexer_shutdown", serde_json::json!({"reason": "signal"}));
    let _ = health_shutdown_tx.send(());
    health_server
        .await
        .context("indexer health task failed")?
        .context("indexer health server failed")
}

fn validate_config(config: &RuntimeConfig) -> Result<()> {
    if config.reconnect_delay.is_zero() {
        bail!("INDEXER_RECONNECT_SECONDS must be greater than zero");
    }
    if config.route_refresh_interval.is_zero() {
        bail!("INDEXER_ROUTE_REFRESH_SECONDS must be greater than zero");
    }
    if config.refresh_interval.is_zero() {
        bail!("LEADERBOARD_REFRESH_SECONDS must be greater than zero");
    }
    if config.catchup_limit == 0 {
        bail!("INDEXER_CATCHUP_LIMIT must be greater than zero");
    }
    Ok(())
}

async fn subscription_session(
    chain: &ProbeConfig,
    storage: &Storage,
    config: &RuntimeConfig,
    runtime: &Arc<RwLock<RuntimeSnapshot>>,
    signal_rx: &mut watch::Receiver<bool>,
) -> Result<SessionExit> {
    let endpoint = resolve_market_endpoint(chain).await?;
    let source = storage
        .ensure_source(chain.network.as_str(), "er", endpoint.as_str())
        .await?;
    let ws_endpoint = websocket_url(&endpoint)?;
    let client = tokio::time::timeout(
        SUBSCRIPTION_TIMEOUT,
        PubsubClient::new(ws_endpoint.as_str()),
    )
    .await
    .context("ER logsSubscribe connection timed out")?
    .context("ER logsSubscribe connection failed")?;
    let (mut stream, unsubscribe) = tokio::time::timeout(
        SUBSCRIPTION_TIMEOUT,
        client.logs_subscribe(
            RpcTransactionLogsFilter::Mentions(vec![chain.program_id.to_string()]),
            RpcTransactionLogsConfig {
                commitment: Some(CommitmentConfig::confirmed()),
            },
        ),
    )
    .await
    .context("ER logsSubscribe handshake timed out")?
    .context("ER logsSubscribe handshake failed")?;
    log_json(
        "indexer_subscription_connected",
        serde_json::json!({
            "endpoint": crate::sources::redact_url(&ws_endpoint),
            "program_id": chain.program_id.to_string(),
        }),
    );

    let catchup = ingest::recent_with_storage(
        storage,
        chain.network.as_str(),
        "er",
        endpoint.as_str(),
        config.catchup_limit,
        config.v2_min_slot,
    )
    .await?;
    if catchup.cursor_before.is_some()
        && !catchup.cursor_found
        && catchup.transactions_scanned >= config.catchup_limit
    {
        bail!(
            "reconnect catch-up did not reach the stored cursor within {} transactions",
            config.catchup_limit
        );
    }
    smoke::run_with_storage(chain, storage, false).await?;
    let refresh =
        leaderboards::refresh_with_storage(storage, false, config.refresh_interval).await?;
    {
        let mut state = runtime.write().expect("runtime metrics lock poisoned");
        state.subscription_connected = true;
        state.last_success_at = Some(Utc::now());
        state.transactions_scanned_total = state
            .transactions_scanned_total
            .saturating_add(u64::try_from(catchup.transactions_scanned).unwrap_or(u64::MAX));
        state.events_applied_total = state
            .events_applied_total
            .saturating_add(u64::try_from(catchup.domain_events_applied).unwrap_or(u64::MAX));
        state.last_cursor_found = catchup.cursor_found;
        state.last_source_high_water_mark = refresh.source_high_water_mark;
        state.last_refresh_duration_ms = refresh.duration_ms;
        state.last_error = None;
    }
    log_json(
        "indexer_subscription_ready",
        serde_json::json!({
            "catchup_transactions_scanned": catchup.transactions_scanned,
            "catchup_events_applied": catchup.domain_events_applied,
            "cursor_found": catchup.cursor_found,
            "endpoint": crate::sources::redact_url(&endpoint),
        }),
    );
    if config.once {
        drop(stream);
        unsubscribe().await;
        return Ok(SessionExit::Shutdown);
    }

    let now = tokio::time::Instant::now();
    let mut route_refresh = tokio::time::interval_at(
        now + config.route_refresh_interval,
        config.route_refresh_interval,
    );
    let mut leaderboard_refresh =
        tokio::time::interval_at(now + config.refresh_interval, config.refresh_interval);
    let exit = loop {
        tokio::select! {
            notification = stream.next() => {
                let Some(notification) = notification else {
                    break SessionExit::StreamEnded;
                };
                let started = Instant::now();
                let report = ingest::logs_with_storage(
                    storage,
                    &source,
                    &notification.value.signature,
                    notification.context.slot,
                    notification.value.err.is_some(),
                    &notification.value.logs,
                    Utc::now(),
                    config.v2_min_slot,
                )
                .await?;
                {
                    let mut state = runtime.write().expect("runtime metrics lock poisoned");
                    state.last_success_at = Some(Utc::now());
                    state.notifications_received_total =
                        state.notifications_received_total.saturating_add(1);
                    state.events_applied_total = state.events_applied_total.saturating_add(
                        u64::try_from(report.events_applied).unwrap_or(u64::MAX),
                    );
                    state.last_error = None;
                }
                if report.events_applied > 0 {
                    log_json(
                        "indexer_notification_applied",
                        serde_json::json!({
                            "signature": notification.value.signature,
                            "slot": notification.context.slot,
                            "events_applied": report.events_applied,
                            "processing_duration_ms": started.elapsed().as_millis(),
                        }),
                    );
                }
            }
            _ = route_refresh.tick() => {
                let latest_endpoint = resolve_market_endpoint(chain).await?;
                if latest_endpoint != endpoint {
                    break SessionExit::RouteChanged;
                }
                mark_success(runtime);
            }
            _ = leaderboard_refresh.tick() => {
                let refresh =
                    leaderboards::refresh_with_storage(storage, false, config.refresh_interval)
                        .await?;
                let mut state = runtime.write().expect("runtime metrics lock poisoned");
                state.last_success_at = Some(Utc::now());
                state.last_source_high_water_mark = refresh.source_high_water_mark;
                state.last_refresh_duration_ms = refresh.duration_ms;
                state.last_error = None;
            }
            changed = signal_rx.changed() => {
                if changed.is_err() || *signal_rx.borrow() {
                    break SessionExit::Shutdown;
                }
            }
        }
    };
    drop(stream);
    unsubscribe().await;
    Ok(exit)
}

async fn resolve_market_endpoint(chain: &ProbeConfig) -> Result<Url> {
    let market_id = chain.market_id.to_le_bytes();
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &chain.program_id);
    let route = RouterClient::new(chain.router.clone())
        .resolve(&market)
        .await?;
    if !route.is_delegated {
        bail!("Market {market} is not delegated");
    }
    route
        .endpoint
        .context("router did not return an ER endpoint for the Market")
}

fn mark_success(runtime: &Arc<RwLock<RuntimeSnapshot>>) {
    let mut state = runtime.write().expect("runtime metrics lock poisoned");
    state.last_success_at = Some(Utc::now());
    state.last_error = None;
}

fn mark_disconnected(runtime: &Arc<RwLock<RuntimeSnapshot>>) {
    runtime
        .write()
        .expect("runtime metrics lock poisoned")
        .subscription_connected = false;
}

fn record_failure(runtime: &Arc<RwLock<RuntimeSnapshot>>, error: String) {
    let mut state = runtime.write().expect("runtime metrics lock poisoned");
    state.failures_total = state.failures_total.saturating_add(1);
    state.last_error = Some(error);
}

fn health_router(state: HealthState) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(metrics))
        .with_state(state)
}

async fn live() -> Json<Health> {
    Json(Health {
        status: "live",
        last_success_at: None,
        stale: false,
        subscription_connected: false,
    })
}

async fn ready(State(state): State<HealthState>) -> Response {
    let snapshot = state
        .runtime
        .read()
        .expect("runtime metrics lock poisoned")
        .clone();
    let stale = !snapshot.subscription_connected
        || is_stale(snapshot.last_success_at, state.maximum_staleness);
    let database_ready = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(state.storage.pool())
        .await
        .is_ok();
    let health = Health {
        status: if database_ready && !stale {
            "ready"
        } else {
            "not_ready"
        },
        last_success_at: snapshot.last_success_at,
        stale,
        subscription_connected: snapshot.subscription_connected,
    };
    (
        if database_ready && !stale {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(health),
    )
        .into_response()
}

async fn metrics(State(state): State<HealthState>) -> Response {
    let snapshot = state
        .runtime
        .read()
        .expect("runtime metrics lock poisoned")
        .clone();
    let database = sqlx::query_as::<_, (Option<i64>, i64)>(
        r#"
        SELECT
            (SELECT max(cursor_slot) FROM indexer.sync_cursors),
            (SELECT count(*) FROM indexer.dead_letters)
        "#,
    )
    .fetch_optional(state.storage.pool())
    .await
    .ok()
    .flatten()
    .unwrap_or((None, 0));
    let attempts = sqlx::query_as::<_, DeadLetterMetrics>(
        r#"
        SELECT count(*)::BIGINT AS dead_letters, COALESCE(sum(attempt_count), 0)::BIGINT AS attempts
        FROM indexer.dead_letters
        "#,
    )
    .fetch_optional(state.storage.pool())
    .await
    .ok()
    .flatten()
    .unwrap_or(DeadLetterMetrics {
        dead_letters: database.1,
        attempts: 0,
    });
    let stale = !snapshot.subscription_connected
        || is_stale(snapshot.last_success_at, state.maximum_staleness);
    let last_success_timestamp = snapshot
        .last_success_at
        .map_or(0, |value| value.timestamp());
    let body = format!(
        "# TYPE leveraged_prediction_indexer_connection_sessions_total counter\n\
         leveraged_prediction_indexer_connection_sessions_total {}\n\
         # TYPE leveraged_prediction_indexer_reconnects_total counter\n\
         leveraged_prediction_indexer_reconnects_total {}\n\
         # TYPE leveraged_prediction_indexer_failures_total counter\n\
         leveraged_prediction_indexer_failures_total {}\n\
         # TYPE leveraged_prediction_indexer_notifications_received_total counter\n\
         leveraged_prediction_indexer_notifications_received_total {}\n\
         # TYPE leveraged_prediction_indexer_transactions_scanned_total counter\n\
         leveraged_prediction_indexer_transactions_scanned_total {}\n\
         # TYPE leveraged_prediction_indexer_events_applied_total counter\n\
         leveraged_prediction_indexer_events_applied_total {}\n\
         # TYPE leveraged_prediction_indexer_dead_letters gauge\n\
         leveraged_prediction_indexer_dead_letters {}\n\
         # TYPE leveraged_prediction_indexer_dead_letter_attempts gauge\n\
         leveraged_prediction_indexer_dead_letter_attempts {}\n\
         # TYPE leveraged_prediction_indexer_cursor_slot gauge\n\
         leveraged_prediction_indexer_cursor_slot {}\n\
         # TYPE leveraged_prediction_indexer_last_success_timestamp gauge\n\
         leveraged_prediction_indexer_last_success_timestamp {}\n\
         # TYPE leveraged_prediction_indexer_subscription_connected gauge\n\
         leveraged_prediction_indexer_subscription_connected {}\n\
         # TYPE leveraged_prediction_indexer_stale gauge\n\
         leveraged_prediction_indexer_stale {}\n\
         # TYPE leveraged_prediction_leaderboard_refresh_duration_ms gauge\n\
         leveraged_prediction_leaderboard_refresh_duration_ms {}\n",
        snapshot.connection_sessions_total,
        snapshot.reconnects_total,
        snapshot.failures_total,
        snapshot.notifications_received_total,
        snapshot.transactions_scanned_total,
        snapshot.events_applied_total,
        attempts.dead_letters,
        attempts.attempts,
        database.0.unwrap_or(0),
        last_success_timestamp,
        i32::from(snapshot.subscription_connected),
        i32::from(stale),
        snapshot.last_refresh_duration_ms,
    );
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

fn is_stale(last_success: Option<DateTime<Utc>>, maximum: Duration) -> bool {
    last_success.is_none_or(|success| {
        Utc::now()
            .signed_duration_since(success)
            .to_std()
            .map_or(true, |elapsed| elapsed > maximum)
    })
}

fn log_json(event: &str, fields: serde_json::Value) {
    println!(
        "{}",
        serde_json::json!({
            "timestamp": Utc::now(),
            "level": "info",
            "service": "leveraged-prediction-indexer",
            "event": event,
            "fields": fields,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_not_ready_before_subscription_connects() {
        assert!(is_stale(None, Duration::from_secs(120)));
        let snapshot = RuntimeSnapshot::new();
        assert!(!snapshot.subscription_connected);
    }

    #[test]
    fn subscription_session_exits_are_distinct() {
        assert_ne!(SessionExit::RouteChanged, SessionExit::StreamEnded);
        assert_ne!(SessionExit::Shutdown, SessionExit::StreamEnded);
    }

    #[test]
    fn websocket_runtime_rejects_zero_duration_or_catchup_bounds() {
        let mut config = RuntimeConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            reconnect_delay: Duration::from_secs(1),
            route_refresh_interval: Duration::from_secs(30),
            refresh_interval: Duration::from_secs(30),
            maximum_staleness: Duration::from_secs(120),
            catchup_limit: 1_000,
            v2_min_slot: 1,
            database_pool_size: 1,
            once: false,
        };
        assert!(validate_config(&config).is_ok());
        config.reconnect_delay = Duration::ZERO;
        assert!(validate_config(&config).is_err());
        config.reconnect_delay = Duration::from_secs(1);
        config.catchup_limit = 0;
        assert!(validate_config(&config).is_err());
    }
}
