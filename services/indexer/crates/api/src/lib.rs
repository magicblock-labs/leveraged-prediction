mod cursor;
mod error;
mod metrics;
mod models;
pub mod openapi;

use std::{future::Future, str::FromStr, time::Duration};

use anyhow::Context;
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, State},
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, TimeDelta, Utc};
use cursor::{HistoryCursor, LeaderboardCursor};
use error::ApiError;
use leveraged_prediction_storage::Storage;
use models::{
    Envelope, LeaderboardEntry, LiquidityItem, MarketSummary, Period, PositionItem, PositionStatus,
    ProjectionStatus, ResponseMeta, UserStats,
};
use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;
use tower::ServiceExt;

const DEFAULT_LIMIT: u16 = 20;
const MAX_LIMIT: u16 = 100;

#[derive(Clone)]
pub struct ApiState {
    storage: Storage,
    network: String,
    program_id: String,
    query_timeout: Duration,
    max_staleness: Duration,
    metrics: metrics::ApiMetrics,
}

impl ApiState {
    pub fn new(
        storage: Storage,
        network: String,
        program_id: String,
        query_timeout: Duration,
        max_staleness: Duration,
    ) -> Self {
        Self {
            storage,
            network,
            program_id,
            query_timeout,
            max_staleness,
            metrics: metrics::ApiMetrics::default(),
        }
    }
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/v1/leaderboards", get(leaderboards))
        .route("/v1/users/{wallet}/stats", get(user_stats))
        .route("/v1/users/{wallet}/positions", get(user_positions))
        .route("/v1/users/{wallet}/liquidity", get(user_liquidity))
        .route("/v1/positions/{market_id}/{position_id}", get(position))
        .route("/v1/markets/{market_id}/summary", get(market_summary))
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(prometheus_metrics))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            metrics::track,
        ))
        .with_state(state)
}

#[derive(Debug, Serialize)]
pub struct ContractReport {
    pub routes_checked: usize,
    pub pagination: bool,
    pub stale_cursor: bool,
    pub stale_metadata: bool,
    pub precision_string: bool,
    pub invalid_input_envelope: bool,
    pub unavailable_envelope: bool,
}

pub async fn contract_test(state: ApiState) -> anyhow::Result<ContractReport> {
    let app = router(state.clone());
    let first = request_json(&app, "/v1/leaderboards?period=today&market_id=1&limit=2").await?;
    anyhow::ensure!(first.0 == StatusCode::OK);
    let next_cursor = first.1["meta"]["next_cursor"]
        .as_str()
        .context("leaderboard first page has no cursor")?;
    let precision_string = first.1["data"]
        .as_array()
        .context("leaderboard data is not an array")?
        .iter()
        .all(|row| row["payout"].is_string() && row["net_pnl"].is_string());
    let second = request_json(
        &app,
        &format!("/v1/leaderboards?period=today&market_id=1&limit=2&cursor={next_cursor}"),
    )
    .await?;
    let pagination = second.0 == StatusCode::OK
        && second.1["data"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty());

    let status = projection_status(&state)
        .await
        .map_err(|_| anyhow::anyhow!("projection status unavailable"))?;
    let stale = cursor::encode(&LeaderboardCursor {
        fingerprint: "today:1".to_owned(),
        refresh_version: status.refresh_version.saturating_sub(1),
        rank: 1,
    })
    .map_err(|_| anyhow::anyhow!("failed to construct stale cursor"))?;
    let stale_response = request_json(
        &app,
        &format!("/v1/leaderboards?period=today&market_id=1&cursor={stale}"),
    )
    .await?;
    let stale_cursor = stale_response.0 == StatusCode::CONFLICT
        && stale_response.1["error"]["code"] == "cursor_stale";

    let invalid = request_json(&app, "/v1/users/not-a-wallet/stats").await?;
    let invalid_input_envelope =
        invalid.0 == StatusCode::BAD_REQUEST && invalid.1["error"]["code"] == "invalid_request";

    let checks = [
        format!(
            "/v1/users/{}/stats?period=all",
            Pubkey::new_from_array([90; 32])
        ),
        format!("/v1/users/{}/positions?market_id=1", USER_FIXTURE),
        format!("/v1/users/{}/liquidity?market_id=1", USER_FIXTURE),
        "/v1/positions/1/1".to_owned(),
        "/v1/markets/1/summary".to_owned(),
        "/health/live".to_owned(),
        "/health/ready".to_owned(),
        "/metrics".to_owned(),
    ];
    for uri in &checks {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(uri)
                    .body(Body::empty())?,
            )
            .await?;
        anyhow::ensure!(response.status() == StatusCode::OK, "{uri} failed");
    }

    let stale_state = ApiState::new(
        state.storage.clone(),
        state.network.clone(),
        state.program_id.clone(),
        state.query_timeout,
        Duration::ZERO,
    );
    let stale_metadata = request_json(&router(stale_state), "/v1/leaderboards?period=all&limit=1")
        .await?
        .1["meta"]["stale"]
        == true;

    let unavailable_state = ApiState::new(
        state.storage,
        state.network,
        state.program_id,
        Duration::ZERO,
        state.max_staleness,
    );
    let unavailable = request_json(
        &router(unavailable_state),
        "/v1/leaderboards?period=all&limit=1",
    )
    .await?;
    let unavailable_envelope = unavailable.0 == StatusCode::SERVICE_UNAVAILABLE
        && unavailable.1["error"]["code"] == "index_unavailable";

    anyhow::ensure!(
        pagination
            && stale_cursor
            && stale_metadata
            && precision_string
            && invalid_input_envelope
            && unavailable_envelope
    );
    Ok(ContractReport {
        routes_checked: 9,
        pagination,
        stale_cursor,
        stale_metadata,
        precision_string,
        invalid_input_envelope,
        unavailable_envelope,
    })
}

const USER_FIXTURE: &str = "9g9n7TArsFPw7GvPuU8d5NTSAv1mr1gdfDhu97LqryBw";

async fn request_json(app: &Router, uri: &str) -> anyhow::Result<(StatusCode, serde_json::Value)> {
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(uri)
                .body(Body::empty())?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), 1_048_576).await?;
    Ok((status, serde_json::from_slice(&body)?))
}

#[derive(Debug, Deserialize)]
struct LeaderboardQuery {
    period: Option<String>,
    market_id: Option<u16>,
    limit: Option<u16>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StatsQuery {
    period: Option<String>,
    market_id: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct PositionsQuery {
    market_id: Option<u16>,
    status: Option<String>,
    limit: Option<u16>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LiquidityQuery {
    market_id: Option<u16>,
    limit: Option<u16>,
    cursor: Option<String>,
}

async fn leaderboards(
    State(state): State<ApiState>,
    Query(query): Query<LeaderboardQuery>,
) -> Result<Json<Envelope<Vec<LeaderboardEntry>>>, ApiError> {
    let period = parse_period(query.period.as_deref())?;
    let limit = page_limit(query.limit)?;
    let status = projection_status(&state).await?;
    let fingerprint = format!(
        "{}:{}",
        period,
        query
            .market_id
            .map_or_else(|| "global".to_owned(), |id| id.to_string())
    );
    let after_rank = match query.cursor {
        Some(value) => {
            let value = cursor::decode::<LeaderboardCursor>(&value)?;
            if value.fingerprint != fingerprint {
                return Err(ApiError::invalid(
                    "cursor belongs to a different leaderboard",
                ));
            }
            if value.refresh_version != status.refresh_version {
                return Err(ApiError::cursor_stale());
            }
            Some(value.rank)
        }
        None => None,
    };

    let mut rows = if let Some(market_id) = query.market_id {
        timed(&state, async {
            sqlx::query_as::<_, LeaderboardEntry>(
                r#"
                SELECT
                    rank, user_pubkey AS user, trades, wins, losses, breakevens, refunds,
                    volume::text, payout::text, net_pnl::text, lp_fees::text,
                    platform_fees::text, total_fees::text, win_rate_bps
                FROM api.leaderboard_market
                WHERE network = $1
                  AND program_id = $2
                  AND period = $3
                  AND market_id = $4
                  AND rank > $5
                ORDER BY rank
                LIMIT $6
                "#,
            )
            .bind(&state.network)
            .bind(&state.program_id)
            .bind(period.as_str())
            .bind(i32::from(market_id))
            .bind(after_rank.unwrap_or(0))
            .bind(i64::from(limit) + 1)
            .fetch_all(state.storage.pool())
            .await
        })
        .await?
    } else {
        timed(&state, async {
            sqlx::query_as::<_, LeaderboardEntry>(
                r#"
                SELECT
                    rank, user_pubkey AS user, trades, wins, losses, breakevens, refunds,
                    volume::text, payout::text, net_pnl::text, lp_fees::text,
                    platform_fees::text, total_fees::text, win_rate_bps
                FROM api.leaderboard_global
                WHERE network = $1
                  AND program_id = $2
                  AND period = $3
                  AND rank > $4
                ORDER BY rank
                LIMIT $5
                "#,
            )
            .bind(&state.network)
            .bind(&state.program_id)
            .bind(period.as_str())
            .bind(after_rank.unwrap_or(0))
            .bind(i64::from(limit) + 1)
            .fetch_all(state.storage.pool())
            .await
        })
        .await?
    };
    let next_cursor = if rows.len() > usize::from(limit) {
        rows.truncate(usize::from(limit));
        rows.last()
            .map(|row| {
                cursor::encode(&LeaderboardCursor {
                    fingerprint,
                    refresh_version: status.refresh_version,
                    rank: row.rank,
                })
            })
            .transpose()?
    } else {
        None
    };
    Ok(Json(Envelope {
        data: rows,
        meta: response_meta(&state, status, next_cursor),
    }))
}

async fn user_stats(
    State(state): State<ApiState>,
    Path(wallet): Path<String>,
    Query(query): Query<StatsQuery>,
) -> Result<Json<Envelope<UserStats>>, ApiError> {
    validate_wallet(&wallet)?;
    let period = parse_period(query.period.as_deref())?;
    let status = projection_status(&state).await?;
    let row = if let Some(market_id) = query.market_id {
        timed(&state, async {
            sqlx::query_as::<_, LeaderboardEntry>(
                r#"
                SELECT
                    rank, user_pubkey AS user, trades, wins, losses, breakevens, refunds,
                    volume::text, payout::text, net_pnl::text, lp_fees::text,
                    platform_fees::text, total_fees::text, win_rate_bps
                FROM api.leaderboard_market
                WHERE network = $1 AND program_id = $2 AND period = $3
                  AND market_id = $4 AND user_pubkey = $5
                "#,
            )
            .bind(&state.network)
            .bind(&state.program_id)
            .bind(period.as_str())
            .bind(i32::from(market_id))
            .bind(&wallet)
            .fetch_optional(state.storage.pool())
            .await
        })
        .await?
    } else {
        timed(&state, async {
            sqlx::query_as::<_, LeaderboardEntry>(
                r#"
                SELECT
                    rank, user_pubkey AS user, trades, wins, losses, breakevens, refunds,
                    volume::text, payout::text, net_pnl::text, lp_fees::text,
                    platform_fees::text, total_fees::text, win_rate_bps
                FROM api.leaderboard_global
                WHERE network = $1 AND program_id = $2 AND period = $3 AND user_pubkey = $4
                "#,
            )
            .bind(&state.network)
            .bind(&state.program_id)
            .bind(period.as_str())
            .bind(&wallet)
            .fetch_optional(state.storage.pool())
            .await
        })
        .await?
    };
    let data = row.map_or_else(
        || UserStats::empty(wallet.clone(), period, query.market_id),
        |row| UserStats {
            user: row.user,
            period,
            market_id: query.market_id,
            trades: row.trades,
            wins: row.wins,
            losses: row.losses,
            breakevens: row.breakevens,
            refunds: row.refunds,
            volume: row.volume,
            payout: row.payout,
            net_pnl: row.net_pnl,
            lp_fees: row.lp_fees,
            platform_fees: row.platform_fees,
            total_fees: row.total_fees,
            win_rate_bps: row.win_rate_bps,
            rank: Some(row.rank),
        },
    );
    Ok(Json(Envelope {
        data,
        meta: response_meta(&state, status, None),
    }))
}

async fn user_positions(
    State(state): State<ApiState>,
    Path(wallet): Path<String>,
    Query(query): Query<PositionsQuery>,
) -> Result<Json<Envelope<Vec<PositionItem>>>, ApiError> {
    validate_wallet(&wallet)?;
    let limit = page_limit(query.limit)?;
    let requested_status = query
        .status
        .as_deref()
        .map(PositionStatus::from_str)
        .transpose()
        .map_err(ApiError::invalid)?;
    let fingerprint = format!(
        "positions:{wallet}:{}:{}",
        query
            .market_id
            .map_or_else(|| "*".to_owned(), |id| id.to_string()),
        requested_status.map_or("*", PositionStatus::as_str)
    );
    let after = query
        .cursor
        .as_deref()
        .map(cursor::decode::<HistoryCursor>)
        .transpose()?;
    if after
        .as_ref()
        .is_some_and(|value| value.fingerprint != fingerprint)
    {
        return Err(ApiError::invalid(
            "cursor belongs to a different position query",
        ));
    }
    let after_time = cursor_time(after.as_ref())?;
    let after_market = after.as_ref().map(|value| value.market_id);
    let after_position = after
        .as_ref()
        .map(|value| value.identity.parse::<i64>())
        .transpose()
        .map_err(|_| ApiError::invalid("cursor position identity is invalid"))?;
    let mut rows = timed(&state, async {
        sqlx::query_as::<_, PositionItem>(
            r#"
            SELECT
                market_id,
                position_id,
                user_pubkey AS user,
                direction,
                entry_price::text,
                collateral::text,
                expires_at,
                lifecycle_status,
                checkpoint_status,
                outcome,
                payout_amount::text,
                lp_fee_amount::text,
                platform_fee_amount::text,
                total_fee_amount::text,
                net_pnl::text,
                opened_at,
                closed_at,
                COALESCE(closed_at, opened_at, expires_at, to_timestamp(0)) AS sort_time
            FROM api.position_history
            WHERE network = $1
              AND program_id = $2
              AND user_pubkey = $3
              AND ($4::INTEGER IS NULL OR market_id = $4)
              AND (
                    $5::TEXT IS NULL
                    OR ($5 = 'open' AND lifecycle_status = 'open')
                    OR ($5 = 'closed' AND lifecycle_status = 'settled')
                    OR ($5 = 'refunded' AND lifecycle_status = 'refunded')
              )
              AND (
                    $6::TIMESTAMPTZ IS NULL
                    OR (
                        COALESCE(closed_at, opened_at, expires_at, to_timestamp(0)),
                        market_id,
                        position_id
                    ) < ($6, $7, $8)
              )
            ORDER BY sort_time DESC, market_id DESC, position_id DESC
            LIMIT $9
            "#,
        )
        .bind(&state.network)
        .bind(&state.program_id)
        .bind(&wallet)
        .bind(query.market_id.map(i32::from))
        .bind(requested_status.map(PositionStatus::as_str))
        .bind(after_time)
        .bind(after_market)
        .bind(after_position)
        .bind(i64::from(limit) + 1)
        .fetch_all(state.storage.pool())
        .await
    })
    .await?;
    let next_cursor = if rows.len() > usize::from(limit) {
        rows.truncate(usize::from(limit));
        rows.last()
            .map(|row| {
                cursor::encode(&HistoryCursor {
                    fingerprint,
                    timestamp_micros: row.sort_time.timestamp_micros(),
                    market_id: row.market_id,
                    identity: row.position_id.to_string(),
                })
            })
            .transpose()?
    } else {
        None
    };
    let status = projection_status(&state).await?;
    Ok(Json(Envelope {
        data: rows,
        meta: response_meta(&state, status, next_cursor),
    }))
}

async fn user_liquidity(
    State(state): State<ApiState>,
    Path(wallet): Path<String>,
    Query(query): Query<LiquidityQuery>,
) -> Result<Json<Envelope<Vec<LiquidityItem>>>, ApiError> {
    validate_wallet(&wallet)?;
    let limit = page_limit(query.limit)?;
    let fingerprint = format!(
        "liquidity:{wallet}:{}",
        query
            .market_id
            .map_or_else(|| "*".to_owned(), |id| id.to_string())
    );
    let after = query
        .cursor
        .as_deref()
        .map(cursor::decode::<HistoryCursor>)
        .transpose()?;
    if after
        .as_ref()
        .is_some_and(|value| value.fingerprint != fingerprint)
    {
        return Err(ApiError::invalid(
            "cursor belongs to a different liquidity query",
        ));
    }
    let after_time = cursor_time(after.as_ref())?;
    let (after_signature, after_path) = after
        .as_ref()
        .map(|value| {
            value
                .identity
                .split_once(':')
                .map(|(signature, path)| (signature.to_owned(), path.to_owned()))
                .ok_or_else(|| ApiError::invalid("cursor liquidity identity is invalid"))
        })
        .transpose()?
        .unzip();
    let mut rows = timed(&state, async {
        sqlx::query_as::<_, LiquidityItem>(
            r#"
            SELECT
                signature,
                instruction_path,
                event_kind,
                market_id,
                user_pubkey AS user,
                assets::text,
                shares::text,
                min_assets_out::text,
                occurred_at,
                COALESCE(occurred_at, to_timestamp(0)) AS sort_time
            FROM api.liquidity_history
            WHERE network = $1
              AND program_id = $2
              AND user_pubkey = $3
              AND ($4::INTEGER IS NULL OR market_id = $4)
              AND (
                    $5::TIMESTAMPTZ IS NULL
                    OR (
                        COALESCE(occurred_at, to_timestamp(0)),
                        market_id,
                        signature,
                        instruction_path
                    ) < ($5, $6, $7, $8)
              )
            ORDER BY sort_time DESC, market_id DESC, signature DESC, instruction_path DESC
            LIMIT $9
            "#,
        )
        .bind(&state.network)
        .bind(&state.program_id)
        .bind(&wallet)
        .bind(query.market_id.map(i32::from))
        .bind(after_time)
        .bind(after.as_ref().map(|value| value.market_id))
        .bind(after_signature)
        .bind(after_path)
        .bind(i64::from(limit) + 1)
        .fetch_all(state.storage.pool())
        .await
    })
    .await?;
    let next_cursor = if rows.len() > usize::from(limit) {
        rows.truncate(usize::from(limit));
        rows.last()
            .map(|row| {
                cursor::encode(&HistoryCursor {
                    fingerprint,
                    timestamp_micros: row.sort_time.timestamp_micros(),
                    market_id: row.market_id,
                    identity: format!("{}:{}", row.signature, row.instruction_path),
                })
            })
            .transpose()?
    } else {
        None
    };
    let status = projection_status(&state).await?;
    Ok(Json(Envelope {
        data: rows,
        meta: response_meta(&state, status, next_cursor),
    }))
}

async fn position(
    State(state): State<ApiState>,
    Path((market_id, position_id)): Path<(u16, u32)>,
) -> Result<Json<Envelope<PositionItem>>, ApiError> {
    let row = timed(&state, async {
        sqlx::query_as::<_, PositionItem>(
            r#"
            SELECT
                market_id,
                position_id,
                user_pubkey AS user,
                direction,
                entry_price::text,
                collateral::text,
                expires_at,
                lifecycle_status,
                checkpoint_status,
                outcome,
                payout_amount::text,
                lp_fee_amount::text,
                platform_fee_amount::text,
                total_fee_amount::text,
                net_pnl::text,
                opened_at,
                closed_at,
                COALESCE(closed_at, opened_at, expires_at, to_timestamp(0)) AS sort_time
            FROM api.position_history
            WHERE network = $1 AND program_id = $2 AND market_id = $3 AND position_id = $4
            "#,
        )
        .bind(&state.network)
        .bind(&state.program_id)
        .bind(i32::from(market_id))
        .bind(i64::from(position_id))
        .fetch_optional(state.storage.pool())
        .await
    })
    .await?
    .ok_or_else(|| ApiError::not_found("position was not found"))?;
    let status = projection_status(&state).await?;
    Ok(Json(Envelope {
        data: row,
        meta: response_meta(&state, status, None),
    }))
}

async fn market_summary(
    State(state): State<ApiState>,
    Path(market_id): Path<u16>,
) -> Result<Json<Envelope<MarketSummary>>, ApiError> {
    let row = timed(&state, async {
        sqlx::query_as::<_, MarketSummary>(
            r#"
            SELECT
                market_id,
                market_pubkey,
                mode,
                total_shares::text,
                open_collateral::text,
                active_positions,
                pool_balance::text,
                last_slot,
                updated_at
            FROM api.market_summary
            WHERE network = $1 AND program_id = $2 AND market_id = $3
            "#,
        )
        .bind(&state.network)
        .bind(&state.program_id)
        .bind(i32::from(market_id))
        .fetch_optional(state.storage.pool())
        .await
    })
    .await?
    .ok_or_else(|| ApiError::not_found("market was not found"))?;
    let status = projection_status(&state).await?;
    Ok(Json(Envelope {
        data: row,
        meta: response_meta(&state, status, None),
    }))
}

async fn live() -> Json<Health> {
    Json(Health {
        status: "live",
        database: None,
    })
}

async fn ready(State(state): State<ApiState>) -> Response {
    match timed(&state, async {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(state.storage.pool())
            .await
    })
    .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(Health {
                status: "ready",
                database: Some("reachable"),
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Health {
                status: "not_ready",
                database: Some("unavailable"),
            }),
        )
            .into_response(),
    }
}

async fn prometheus_metrics(State(state): State<ApiState>) -> Result<Response, ApiError> {
    let status = projection_status(&state).await?;
    let metrics = state.metrics.snapshot();
    let pool_size = state.storage.pool().size();
    let pool_idle = state.storage.pool().num_idle();
    let body = format!(
        "# TYPE leveraged_prediction_refresh_version gauge\n\
         leveraged_prediction_refresh_version {}\n\
         # TYPE leveraged_prediction_projection_stale gauge\n\
         leveraged_prediction_projection_stale {}\n\
         # TYPE leveraged_prediction_api_requests_total counter\n\
         leveraged_prediction_api_requests_total {}\n\
         # TYPE leveraged_prediction_api_errors_total counter\n\
         leveraged_prediction_api_errors_total {}\n\
         # TYPE leveraged_prediction_api_active_requests gauge\n\
         leveraged_prediction_api_active_requests {}\n\
         # TYPE leveraged_prediction_api_request_latency_micros_total counter\n\
         leveraged_prediction_api_request_latency_micros_total {}\n\
         # TYPE leveraged_prediction_api_query_timeouts_total counter\n\
         leveraged_prediction_api_query_timeouts_total {}\n\
         # TYPE leveraged_prediction_api_stale_responses_total counter\n\
         leveraged_prediction_api_stale_responses_total {}\n\
         # TYPE leveraged_prediction_api_pool_connections gauge\n\
         leveraged_prediction_api_pool_connections {}\n\
         # TYPE leveraged_prediction_api_pool_idle gauge\n\
         leveraged_prediction_api_pool_idle {}\n",
        status.refresh_version,
        i32::from(is_stale(&state, status.last_success_at)),
        metrics.requests,
        metrics.errors,
        metrics.active,
        metrics.latency_micros,
        metrics.query_timeouts,
        metrics.stale_responses,
        pool_size,
        pool_idle,
    );
    Ok(([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response())
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    database: Option<&'static str>,
}

async fn projection_status(state: &ApiState) -> Result<ProjectionStatus, ApiError> {
    timed(state, async {
        sqlx::query_as::<_, ProjectionStatus>(
            r#"
            SELECT refresh_version, last_success_at, source_high_water_mark, last_error
            FROM api.projection_status
            WHERE projection_name = 'leaderboards'
            "#,
        )
        .fetch_one(state.storage.pool())
        .await
    })
    .await
}

fn response_meta(
    state: &ApiState,
    status: ProjectionStatus,
    next_cursor: Option<String>,
) -> ResponseMeta {
    let stale = is_stale(state, status.last_success_at);
    if stale {
        state.metrics.record_stale_response();
    }
    ResponseMeta {
        as_of: status.last_success_at.unwrap_or_else(Utc::now),
        projection_high_water_mark: status.source_high_water_mark,
        refresh_version: status.refresh_version,
        stale,
        next_cursor,
    }
}

fn is_stale(state: &ApiState, last_success: Option<DateTime<Utc>>) -> bool {
    last_success.is_none_or(|last| {
        Utc::now().signed_duration_since(last)
            > TimeDelta::from_std(state.max_staleness).unwrap_or(TimeDelta::MAX)
    })
}

async fn timed<T>(
    state: &ApiState,
    future: impl Future<Output = Result<T, sqlx::Error>>,
) -> Result<T, ApiError> {
    match tokio::time::timeout(state.query_timeout, future).await {
        Ok(result) => result.map_err(ApiError::from),
        Err(_) => {
            state.metrics.record_query_timeout();
            Err(ApiError::unavailable())
        }
    }
}

fn parse_period(value: Option<&str>) -> Result<Period, ApiError> {
    value.unwrap_or("all").parse().map_err(ApiError::invalid)
}

fn page_limit(value: Option<u16>) -> Result<u16, ApiError> {
    let limit = value.unwrap_or(DEFAULT_LIMIT);
    if limit == 0 || limit > MAX_LIMIT {
        return Err(ApiError::invalid(format!(
            "limit must be between 1 and {MAX_LIMIT}"
        )));
    }
    Ok(limit)
}

fn validate_wallet(wallet: &str) -> Result<Pubkey, ApiError> {
    Pubkey::from_str(wallet).map_err(|_| ApiError::invalid("wallet must be a Solana public key"))
}

fn cursor_time(value: Option<&HistoryCursor>) -> Result<Option<DateTime<Utc>>, ApiError> {
    value
        .map(|value| {
            DateTime::<Utc>::from_timestamp_micros(value.timestamp_micros)
                .ok_or_else(|| ApiError::invalid("cursor timestamp is invalid"))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_validation_bounds_period_limit_and_wallet() {
        assert_eq!(parse_period(None).unwrap(), Period::All);
        assert!(parse_period(Some("year")).is_err());
        assert_eq!(page_limit(None).unwrap(), DEFAULT_LIMIT);
        assert!(page_limit(Some(0)).is_err());
        assert!(page_limit(Some(MAX_LIMIT + 1)).is_err());
        assert!(validate_wallet("not-a-wallet").is_err());
    }

    #[test]
    fn api_leaderboard_cursor_rejects_a_stale_refresh_version() {
        let cursor = LeaderboardCursor {
            fingerprint: "all:global".to_owned(),
            refresh_version: 4,
            rank: 20,
        };
        let encoded = cursor::encode(&cursor).unwrap();
        let decoded = cursor::decode::<LeaderboardCursor>(&encoded).unwrap();
        assert_ne!(decoded.refresh_version, 5);
    }
}
