use std::{
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::Duration,
};

use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use leveraged_prediction_storage::Storage;
use serde::Serialize;
use solana_pubkey::Pubkey;
use tokio::sync::oneshot;

use crate::{ingest, projections::leaderboards, smoke, sources::router::RouterClient, ProbeConfig};

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub bind: SocketAddr,
    pub poll_interval: Duration,
    pub refresh_interval: Duration,
    pub maximum_staleness: Duration,
    pub crawl_limit: usize,
    pub v2_min_slot: u64,
    pub database_pool_size: u32,
    pub once: bool,
}

#[derive(Clone, Debug, Serialize)]
struct RuntimeSnapshot {
    started_at: DateTime<Utc>,
    last_attempt_at: Option<DateTime<Utc>>,
    last_success_at: Option<DateTime<Utc>>,
    cycles_total: u64,
    failures_total: u64,
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
            cycles_total: 0,
            failures_total: 0,
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
}

#[derive(Debug, sqlx::FromRow)]
struct DeadLetterMetrics {
    dead_letters: i64,
    attempts: i64,
}

pub async fn run(chain: ProbeConfig, database_url: &str, config: RuntimeConfig) -> Result<()> {
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
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let health_server = tokio::spawn(async move {
        axum::serve(listener, health_router(health_state))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    log_json(
        "indexer_started",
        serde_json::json!({
            "health_bind": local_addr,
            "network": chain.network.as_str(),
            "program_id": chain.program_id.to_string(),
            "market_id": chain.market_id,
            "v2_min_slot": config.v2_min_slot,
        }),
    );

    let mut cycle_result = cycle(&chain, &storage, &config, &runtime).await;
    if config.once {
        let _ = shutdown_tx.send(());
        health_server
            .await
            .context("indexer health task failed")?
            .context("indexer health server failed")?;
        return cycle_result;
    }

    loop {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to listen for shutdown signal")?;
                log_json("indexer_shutdown", serde_json::json!({"reason": "signal"}));
                break;
            }
            () = tokio::time::sleep(config.poll_interval) => {
                cycle_result = cycle(&chain, &storage, &config, &runtime).await;
                if let Err(error) = &cycle_result {
                    log_json("indexer_cycle_failed", serde_json::json!({"error": error.to_string()}));
                }
            }
        }
    }
    let _ = shutdown_tx.send(());
    health_server
        .await
        .context("indexer health task failed")?
        .context("indexer health server failed")
}

async fn cycle(
    chain: &ProbeConfig,
    storage: &Storage,
    config: &RuntimeConfig,
    runtime: &Arc<RwLock<RuntimeSnapshot>>,
) -> Result<()> {
    {
        let mut state = runtime.write().expect("runtime metrics lock poisoned");
        state.last_attempt_at = Some(Utc::now());
        state.cycles_total = state.cycles_total.saturating_add(1);
    }
    let result = cycle_inner(chain, storage, config).await;
    let mut state = runtime.write().expect("runtime metrics lock poisoned");
    match result {
        Ok(report) => {
            state.last_success_at = Some(Utc::now());
            state.transactions_scanned_total = state
                .transactions_scanned_total
                .saturating_add(u64::try_from(report.transactions_scanned).unwrap_or(u64::MAX));
            state.events_applied_total = state
                .events_applied_total
                .saturating_add(u64::try_from(report.events_applied).unwrap_or(u64::MAX));
            state.last_cursor_found = report.cursor_found;
            state.last_source_high_water_mark = report.source_high_water_mark;
            state.last_refresh_duration_ms = report.refresh_duration_ms;
            state.last_error = None;
            log_json(
                "indexer_cycle_completed",
                serde_json::json!({
                    "transactions_scanned": report.transactions_scanned,
                    "events_applied": report.events_applied,
                    "cursor_found": report.cursor_found,
                    "source_high_water_mark": report.source_high_water_mark,
                    "refresh_duration_ms": report.refresh_duration_ms,
                }),
            );
            Ok(())
        }
        Err(error) => {
            state.failures_total = state.failures_total.saturating_add(1);
            state.last_error = Some(error.to_string());
            Err(error)
        }
    }
}

struct CycleReport {
    transactions_scanned: usize,
    events_applied: usize,
    cursor_found: bool,
    source_high_water_mark: Option<i64>,
    refresh_duration_ms: u64,
}

async fn cycle_inner(
    chain: &ProbeConfig,
    storage: &Storage,
    config: &RuntimeConfig,
) -> Result<CycleReport> {
    let market_id = chain.market_id.to_le_bytes();
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &chain.program_id);
    let route = RouterClient::new(chain.router.clone())
        .resolve(&market)
        .await?;
    let endpoint = route
        .endpoint
        .context("router did not return an ER endpoint for the Market")?;

    smoke::run_with_storage(chain, storage, false).await?;
    let ingest = ingest::recent_with_storage(
        storage,
        chain.network.as_str(),
        "er",
        endpoint.as_str(),
        config.crawl_limit,
        config.v2_min_slot,
    )
    .await?;
    let refresh =
        leaderboards::refresh_with_storage(storage, false, config.refresh_interval).await?;
    Ok(CycleReport {
        transactions_scanned: ingest.transactions_scanned,
        events_applied: ingest.domain_events_applied,
        cursor_found: ingest.cursor_found,
        source_high_water_mark: refresh.source_high_water_mark,
        refresh_duration_ms: refresh.duration_ms,
    })
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
    })
}

async fn ready(State(state): State<HealthState>) -> Response {
    let snapshot = state
        .runtime
        .read()
        .expect("runtime metrics lock poisoned")
        .clone();
    let stale = is_stale(snapshot.last_success_at, state.maximum_staleness);
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
    let stale = is_stale(snapshot.last_success_at, state.maximum_staleness);
    let last_success_timestamp = snapshot
        .last_success_at
        .map_or(0, |value| value.timestamp());
    let body = format!(
        "# TYPE leveraged_prediction_indexer_cycles_total counter\n\
         leveraged_prediction_indexer_cycles_total {}\n\
         # TYPE leveraged_prediction_indexer_failures_total counter\n\
         leveraged_prediction_indexer_failures_total {}\n\
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
         # TYPE leveraged_prediction_indexer_stale gauge\n\
         leveraged_prediction_indexer_stale {}\n\
         # TYPE leveraged_prediction_leaderboard_refresh_duration_ms gauge\n\
         leveraged_prediction_leaderboard_refresh_duration_ms {}\n",
        snapshot.cycles_total,
        snapshot.failures_total,
        snapshot.transactions_scanned_total,
        snapshot.events_applied_total,
        attempts.dead_letters,
        attempts.attempts,
        database.0.unwrap_or(0),
        last_success_timestamp,
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
    fn runtime_is_not_ready_before_first_success() {
        assert!(is_stale(None, Duration::from_secs(120)));
    }
}
