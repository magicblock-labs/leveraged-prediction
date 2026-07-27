use std::time::Duration;

use anyhow::{ensure, Context, Result};
use leveraged_prediction_storage::Storage;
use serde::Serialize;
use solana_pubkey::Pubkey;
use sqlx::postgres::PgListener;

use crate::projections::leaderboards::{self, RefreshReport};

const NETWORK: &str = "api-fixture";
const PROGRAM_ID: &str = "AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr";
const USER_A: &str = "9g9n7TArsFPw7GvPuU8d5NTSAv1mr1gdfDhu97LqryBw";
const USER_B: &str = "GmaDrppBC7CeZibMYcvYQiVLn9kNnV9HRDBtTRb9HqvW";

#[derive(Debug, Serialize, sqlx::FromRow)]
struct FixtureRow {
    period: String,
    market_id: Option<i32>,
    user_pubkey: String,
    trades: i64,
    wins: i64,
    losses: i64,
    breakevens: i64,
    refunds: i64,
    volume: String,
    payout: String,
    net_pnl: String,
    total_fees: String,
    win_rate_bps: i32,
    rank: i64,
}

#[derive(Debug, Serialize)]
pub struct LeaderboardFixtureReport {
    first_refresh: RefreshReport,
    second_refresh: RefreshReport,
    market_rows: i64,
    global_rows: i64,
    projection_hash: String,
    read_during_refresh: bool,
    precision_payout: String,
    tie_order: Vec<String>,
    api_role_select_allowed: bool,
    api_role_forbidden_actions: usize,
    position_notification: bool,
    sample: Vec<FixtureRow>,
}

pub async fn run(database_url: &str) -> Result<LeaderboardFixtureReport> {
    let storage = Storage::connect(database_url).await?;
    storage.migrate().await?;
    let source = storage
        .ensure_source(NETWORK, "er", "http://api-fixture.invalid/")
        .await?;
    reset(&storage, source.id).await?;
    let mut position_listener = PgListener::connect(database_url).await?;
    position_listener
        .listen("leveraged_prediction_positions")
        .await?;
    seed(&storage, source.id).await?;
    let notification = tokio::time::timeout(Duration::from_secs(2), position_listener.recv())
        .await
        .context("position notification timed out")??;
    let notification: serde_json::Value = serde_json::from_str(notification.payload())?;
    let position_notification = notification["network"] == NETWORK
        && notification["program_id"] == PROGRAM_ID
        && notification["user"].is_string()
        && notification["market_id"].is_number()
        && notification["position_id"].is_number();
    ensure!(position_notification);

    let first_refresh = leaderboards::refresh(database_url, true, Duration::from_secs(30)).await?;
    let read_pool = storage.pool().clone();
    let refresh = leaderboards::refresh(database_url, true, Duration::from_secs(30));
    let read = async move {
        tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM api.leaderboard_global WHERE network = $1",
            )
            .bind(NETWORK)
            .fetch_one(&read_pool),
        )
        .await
        .context("leaderboard read blocked during concurrent refresh")?
        .context("leaderboard read failed during concurrent refresh")
    };
    let (second_refresh, read_count) = tokio::join!(refresh, read);
    let second_refresh = second_refresh?;
    let read_during_refresh = read_count? > 0;

    let market_rows = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM api.leaderboard_market WHERE network = $1",
    )
    .bind(NETWORK)
    .fetch_one(storage.pool())
    .await?;
    let global_rows = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM api.leaderboard_global WHERE network = $1",
    )
    .bind(NETWORK)
    .fetch_one(storage.pool())
    .await?;
    let projection_hash = sqlx::query_scalar::<_, String>(
        r#"
        SELECT md5(
            COALESCE(
                jsonb_agg(to_jsonb(rows) ORDER BY scope, period, market_id, rank)::text,
                '[]'
            )
        )
        FROM (
            SELECT
                'market'::TEXT AS scope,
                period,
                market_id,
                user_pubkey,
                trades,
                wins,
                losses,
                breakevens,
                refunds,
                volume::text,
                payout::text,
                net_pnl::text,
                total_fees::text,
                win_rate_bps,
                rank
            FROM api.leaderboard_market
            WHERE network = $1
            UNION ALL
            SELECT
                'global'::TEXT,
                period,
                NULL::INTEGER,
                user_pubkey,
                trades,
                wins,
                losses,
                breakevens,
                refunds,
                volume::text,
                payout::text,
                net_pnl::text,
                total_fees::text,
                win_rate_bps,
                rank
            FROM api.leaderboard_global
            WHERE network = $1
        ) rows
        "#,
    )
    .bind(NETWORK)
    .fetch_one(storage.pool())
    .await?;
    let precision_user = Pubkey::new_from_array([5; 32]).to_string();
    let precision_payout = sqlx::query_scalar::<_, String>(
        r#"
        SELECT payout::text
        FROM api.leaderboard_global
        WHERE network = $1 AND period = 'today' AND user_pubkey = $2
        "#,
    )
    .bind(NETWORK)
    .bind(&precision_user)
    .fetch_one(storage.pool())
    .await?;
    let tie_users = [
        Pubkey::new_from_array([3; 32]).to_string(),
        Pubkey::new_from_array([4; 32]).to_string(),
    ];
    let tie_order = sqlx::query_scalar::<_, String>(
        r#"
        SELECT user_pubkey
        FROM api.leaderboard_market
        WHERE network = $1
          AND market_id = 1
          AND period = 'today'
          AND user_pubkey = ANY($2)
        ORDER BY rank
        "#,
    )
    .bind(NETWORK)
    .bind(&tie_users)
    .fetch_all(storage.pool())
    .await?;
    let sample = sqlx::query_as::<_, FixtureRow>(
        r#"
        SELECT
            period,
            market_id,
            user_pubkey,
            trades,
            wins,
            losses,
            breakevens,
            refunds,
            volume::text,
            payout::text,
            net_pnl::text,
            total_fees::text,
            win_rate_bps,
            rank
        FROM api.leaderboard_market
        WHERE network = $1 AND market_id = 1 AND period = 'today'
        ORDER BY rank
        "#,
    )
    .bind(NETWORK)
    .fetch_all(storage.pool())
    .await?;

    let user_a = sample
        .iter()
        .find(|row| row.user_pubkey == USER_A)
        .context("USER_A missing from today leaderboard")?;
    let user_b = sample
        .iter()
        .find(|row| row.user_pubkey == USER_B)
        .context("USER_B missing from today leaderboard")?;
    ensure!(
        user_a.trades == 2
            && user_a.wins == 1
            && user_a.losses == 1
            && user_a.win_rate_bps == 5_000
            && user_a.net_pnl == "-1000000"
    );
    ensure!(
        user_b.trades == 1
            && user_b.breakevens == 1
            && user_b.refunds == 1
            && user_b.volume == "1000000"
            && user_b.total_fees == "0"
    );
    ensure!(precision_payout == "9007199254740993");
    let mut expected_tie_order = tie_users.to_vec();
    expected_tie_order.sort();
    ensure!(tie_order == expected_tie_order);
    ensure!(read_during_refresh);
    let (api_role_select_allowed, api_role_forbidden_actions) = verify_api_role(&storage).await?;
    ensure!(api_role_select_allowed);
    ensure!(api_role_forbidden_actions == 3);

    Ok(LeaderboardFixtureReport {
        first_refresh,
        second_refresh,
        market_rows,
        global_rows,
        projection_hash,
        read_during_refresh,
        precision_payout,
        tie_order,
        api_role_select_allowed,
        api_role_forbidden_actions,
        position_notification,
        sample,
    })
}

async fn verify_api_role(storage: &Storage) -> Result<(bool, usize)> {
    let mut allowed = storage.pool().begin().await?;
    sqlx::query("SET LOCAL ROLE leveraged_prediction_api")
        .execute(&mut *allowed)
        .await?;
    let _: i64 = sqlx::query_scalar("SELECT count(*) FROM api.leaderboard_global")
        .fetch_one(&mut *allowed)
        .await?;
    allowed.rollback().await?;

    let mut forbidden = 0;
    for statement in [
        "SELECT count(*) FROM indexer.transactions",
        "INSERT INTO indexer.sync_cursors (source_id, datasource, cursor_value) VALUES (0, 'forbidden', 'forbidden')",
        "REFRESH MATERIALIZED VIEW api.leaderboard_global",
    ] {
        let mut transaction = storage.pool().begin().await?;
        sqlx::query("SET LOCAL ROLE leveraged_prediction_api")
            .execute(&mut *transaction)
            .await?;
        if sqlx::query(statement)
            .execute(&mut *transaction)
            .await
            .is_err()
        {
            forbidden += 1;
        }
        transaction.rollback().await?;
    }
    Ok((true, forbidden))
}

async fn reset(storage: &Storage, source_id: i64) -> Result<()> {
    let mut tx = storage.pool().begin().await?;
    sqlx::query("DELETE FROM indexer.fee_events WHERE network = $1")
        .bind(NETWORK)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.liquidity_events WHERE network = $1")
        .bind(NETWORK)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.positions WHERE network = $1")
        .bind(NETWORK)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.markets WHERE network = $1")
        .bind(NETWORK)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.instructions WHERE source_id = $1")
        .bind(source_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.transactions WHERE source_id = $1")
        .bind(source_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn seed(storage: &Storage, source_id: i64) -> Result<()> {
    let users = [
        USER_A.to_owned(),
        USER_B.to_owned(),
        Pubkey::new_from_array([3; 32]).to_string(),
        Pubkey::new_from_array([4; 32]).to_string(),
        Pubkey::new_from_array([5; 32]).to_string(),
    ];
    let mut tx = storage.pool().begin().await?;
    for slot in 1_i64..=11 {
        sqlx::query(
            r#"
            INSERT INTO indexer.transactions (
                source_id, signature, slot, succeeded, event_contract_version
            )
            VALUES ($1, $2, $3, true, 2)
            "#,
        )
        .bind(source_id)
        .bind(format!("api-fixture-{slot}"))
        .bind(slot)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        r#"
        INSERT INTO indexer.markets (
            network, program_id, market_id, market_pubkey, mode, total_shares,
            open_collateral, active_positions, pool_balance, last_source_id,
            last_slot
        )
        VALUES ($1, $2, 1, $3, 'open', 100000000, 3000000, 0, 100000000, $4, 11)
        "#,
    )
    .bind(NETWORK)
    .bind(PROGRAM_ID)
    .bind("6ME7jFHJkk27zAM7hz2A3V1Y4EeTkcjyZxnekQLtn8V1")
    .bind(source_id)
    .execute(&mut *tx)
    .await?;

    let rows = [
        (
            1_i64,
            1_i32,
            &users[0],
            "won",
            1_000_000_i64,
            2_000_000_i64,
            80_000_i64,
            20_000_i64,
            "today",
        ),
        (2, 1, &users[0], "lost", 2_000_000, 0, 0, 0, "today"),
        (
            3,
            1,
            &users[1],
            "breakeven",
            1_000_000,
            1_000_000,
            0,
            0,
            "today",
        ),
        (
            4, 1, &users[1], "refunded", 2_000_000, 2_000_000, 400_000, 100_000, "today",
        ),
        (
            5, 1, &users[2], "won", 1_000_000, 2_000_000, 80_000, 20_000, "today",
        ),
        (
            6, 1, &users[3], "won", 1_000_000, 2_000_000, 80_000, 20_000, "today",
        ),
        (
            7, 2, &users[0], "won", 1_000_000, 1_500_000, 40_000, 10_000, "month",
        ),
        (8, 2, &users[1], "lost", 1_000_000, 0, 0, 0, "all"),
        (
            9,
            1,
            &users[4],
            "won",
            1_000_000,
            9_007_199_254_740_993,
            1,
            1,
            "today",
        ),
    ];
    for (position_id, market_id, user, outcome, collateral, payout, lp_fee, platform_fee, period) in
        rows
    {
        let lifecycle = if outcome == "refunded" {
            "refunded"
        } else {
            "settled"
        };
        let closed_expression = match period {
            "today" => "now() - interval '1 hour'",
            "month" => {
                "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day'"
            }
            "all" => "now() - interval '40 days'",
            _ => unreachable!(),
        };
        let query = format!(
            r#"
            INSERT INTO indexer.positions (
                network, program_id, market_id, position_id, user_pubkey,
                entry_price, collateral, direction, expires_at, lifecycle_status,
                outcome, payout_amount, lp_fee_amount, platform_fee_amount,
                opened_at, closed_at, event_contract_version, is_partial,
                created_source_id, created_signature, closed_source_id,
                closed_signature, last_slot
            )
            VALUES (
                $1, $2, $3, $4, $5,
                100000, $6, 'up', {closed_expression}, $7,
                $8, $9, $10, $11,
                {closed_expression} - interval '10 seconds', {closed_expression},
                2, false, $12, $13, $12, $14, $15
            )
            "#
        );
        sqlx::query(&query)
            .bind(NETWORK)
            .bind(PROGRAM_ID)
            .bind(market_id)
            .bind(position_id)
            .bind(user)
            .bind(collateral)
            .bind(lifecycle)
            .bind(outcome)
            .bind(payout)
            .bind(lp_fee)
            .bind(platform_fee)
            .bind(source_id)
            .bind(format!("api-fixture-open-{position_id}"))
            .bind(format!("api-fixture-close-{position_id}"))
            .bind(position_id)
            .execute(&mut *tx)
            .await?;
    }

    for (index, kind, assets) in [
        (10_i64, "protocol_withdrawal", 777_777_i64),
        (11_i64, "fallback_claim", 888_888_i64),
    ] {
        sqlx::query(
            r#"
            INSERT INTO indexer.fee_events (
                source_id, signature, instruction_path, event_kind, network,
                program_id, market_id, user_pubkey, destination, assets,
                occurred_at, event_contract_version
            )
            VALUES (
                $1, $2, 'log/0', $3, $4, $5,
                CASE WHEN $3 = 'protocol_withdrawal' THEN 1 ELSE NULL END,
                CASE WHEN $3 = 'fallback_claim' THEN $6 ELSE NULL END,
                $6, $7, now(), 2
            )
            "#,
        )
        .bind(source_id)
        .bind(format!("api-fixture-{index}"))
        .bind(kind)
        .bind(NETWORK)
        .bind(PROGRAM_ID)
        .bind(&users[0])
        .bind(assets)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
