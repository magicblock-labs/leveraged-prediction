use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{Datelike, NaiveDate, Utc};
use leveraged_prediction_storage::Storage;
use serde::Serialize;
use sqlx::{pool::PoolConnection, Postgres};

const ADVISORY_LOCK_NAME: &str = "leveraged_prediction_leaderboards_v1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshOutcome {
    Refreshed,
    Coalesced,
    LockHeld,
}

#[derive(Debug, Serialize)]
pub struct RefreshReport {
    pub outcome: RefreshOutcome,
    pub refresh_version: i64,
    pub source_high_water_mark: Option<i64>,
    pub duration_ms: u64,
}

#[derive(sqlx::FromRow)]
struct RefreshState {
    refresh_version: i64,
    last_success_at: Option<chrono::DateTime<Utc>>,
    utc_day: Option<NaiveDate>,
    utc_week: Option<NaiveDate>,
    utc_month: Option<NaiveDate>,
    source_high_water_mark: Option<i64>,
}

pub async fn refresh(
    database_url: &str,
    force: bool,
    minimum_interval: Duration,
) -> Result<RefreshReport> {
    let storage = Storage::connect(database_url).await?;
    storage.require_current_schema().await?;
    refresh_with_storage(&storage, force, minimum_interval).await
}

pub async fn refresh_with_storage(
    storage: &Storage,
    force: bool,
    minimum_interval: Duration,
) -> Result<RefreshReport> {
    let mut connection = storage.pool().acquire().await?;
    let locked = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_lock(hashtext($1))")
        .bind(ADVISORY_LOCK_NAME)
        .fetch_one(&mut *connection)
        .await?;
    if !locked {
        let state = state(&mut connection).await?;
        return Ok(RefreshReport {
            outcome: RefreshOutcome::LockHeld,
            refresh_version: state.refresh_version,
            source_high_water_mark: state.source_high_water_mark,
            duration_ms: 0,
        });
    }

    let result = refresh_locked(&mut connection, force, minimum_interval).await;
    let unlock = sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock(hashtext($1))")
        .bind(ADVISORY_LOCK_NAME)
        .fetch_one(&mut *connection)
        .await;
    match (result, unlock) {
        (Ok(report), Ok(true)) => Ok(report),
        (Ok(_), Ok(false)) => anyhow::bail!("leaderboard advisory lock was not held at unlock"),
        (Ok(_), Err(error)) => Err(error).context("failed to release leaderboard advisory lock"),
        (Err(error), _) => Err(error),
    }
}

async fn refresh_locked(
    connection: &mut PoolConnection<Postgres>,
    force: bool,
    minimum_interval: Duration,
) -> Result<RefreshReport> {
    let current = state(connection).await?;
    let now = Utc::now();
    let day = now.date_naive();
    let week = day - chrono::Days::new(u64::from(day.weekday().num_days_from_monday()));
    let month = day
        .with_day(1)
        .context("current UTC date has no first day")?;
    let crossed_boundary = current.utc_day != Some(day)
        || current.utc_week != Some(week)
        || current.utc_month != Some(month);
    let recent = current.last_success_at.is_some_and(|last| {
        now.signed_duration_since(last)
            .to_std()
            .is_ok_and(|elapsed| elapsed < minimum_interval)
    });
    if !force && recent && !crossed_boundary {
        return Ok(RefreshReport {
            outcome: RefreshOutcome::Coalesced,
            refresh_version: current.refresh_version,
            source_high_water_mark: current.source_high_water_mark,
            duration_ms: 0,
        });
    }

    sqlx::query(
        r#"
        UPDATE indexer.projection_refresh_state
        SET last_attempt_at = now(), last_error = NULL
        WHERE projection_name = 'leaderboards'
        "#,
    )
    .execute(&mut **connection)
    .await?;
    let started = Instant::now();
    let refresh_result = async {
        sqlx::query("REFRESH MATERIALIZED VIEW CONCURRENTLY api.leaderboard_market")
            .execute(&mut **connection)
            .await?;
        sqlx::query("REFRESH MATERIALIZED VIEW CONCURRENTLY api.leaderboard_global")
            .execute(&mut **connection)
            .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    if let Err(error) = refresh_result {
        let message = error.to_string();
        sqlx::query(
            r#"
            UPDATE indexer.projection_refresh_state
            SET last_duration_ms = $1, last_error = left($2, 2048)
            WHERE projection_name = 'leaderboards'
            "#,
        )
        .bind(i64::try_from(duration_ms).unwrap_or(i64::MAX))
        .bind(&message)
        .execute(&mut **connection)
        .await?;
        return Err(error).context("leaderboard materialized-view refresh failed");
    }

    let high_water = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT max(slot) FROM indexer.transactions WHERE succeeded",
    )
    .fetch_one(&mut **connection)
    .await?;
    let updated = sqlx::query_as::<_, (i64, Option<i64>)>(
        r#"
        UPDATE indexer.projection_refresh_state
        SET
            refresh_version = refresh_version + 1,
            last_success_at = now(),
            last_duration_ms = $1,
            source_high_water_mark = $2,
            utc_day = $3,
            utc_week = $4,
            utc_month = $5,
            last_error = NULL
        WHERE projection_name = 'leaderboards'
        RETURNING refresh_version, source_high_water_mark
        "#,
    )
    .bind(i64::try_from(duration_ms).unwrap_or(i64::MAX))
    .bind(high_water)
    .bind(day)
    .bind(week)
    .bind(month)
    .fetch_one(&mut **connection)
    .await?;
    Ok(RefreshReport {
        outcome: RefreshOutcome::Refreshed,
        refresh_version: updated.0,
        source_high_water_mark: updated.1,
        duration_ms,
    })
}

async fn state(connection: &mut PoolConnection<Postgres>) -> Result<RefreshState> {
    Ok(sqlx::query_as::<_, RefreshState>(
        r#"
        SELECT
            refresh_version,
            last_success_at,
            utc_day,
            utc_week,
            utc_month,
            source_high_water_mark
        FROM indexer.projection_refresh_state
        WHERE projection_name = 'leaderboards'
        "#,
    )
    .fetch_one(&mut **connection)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaderboard_recovery_week_boundary_is_monday_utc() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 24).unwrap();
        let start = date - chrono::Days::new(u64::from(date.weekday().num_days_from_monday()));
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 7, 20).unwrap());
    }
}
