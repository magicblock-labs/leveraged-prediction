use anyhow::{ensure, Context, Result};
use chrono::{DateTime, TimeDelta, Utc};
use leveraged_prediction_storage::{
    Direction, DomainEvent, Observation, PositionHistory, PositionOutcome, Source, Storage,
};
use serde::Serialize;
use serde_json::json;

const PROGRAM_ID: &str = "AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr";
const USER: &str = "9g9n7TArsFPw7GvPuU8d5NTSAv1mr1gdfDhu97LqryBw";
const DESTINATION: &str = "GmaDrppBC7CeZibMYcvYQiVLn9kNnV9HRDBtTRb9HqvW";
const LEGACY_OPEN_SIGNATURE: &str =
    "4Sggfo6JZC9hEtenrQYnSXT3sqDyiGfvNDS6wd8UPd2uDybyKXVNx88Nq1BJ1WieHDYc1wQv3psNWYX2GPVBtw2U";
const LEGACY_SETTLEMENT_SIGNATURE: &str =
    "2u7JyLqDjxLsoosMGvmubfXV2qAFn3z6xq4MVr1P9uzsJGg6rbvNSGAQboST5Gxn6EARcMUzgU4GjARKc7p6krtg";

#[derive(Debug, Serialize)]
pub struct FixtureReport {
    passes: u8,
    transactions: i64,
    instructions: i64,
    positions: i64,
    liquidity_events: i64,
    fee_events: i64,
    account_observations: i64,
    pool_balance: i64,
    total_shares: String,
    lp_assets_from_snapshot: i64,
    cursor: String,
    history: Vec<PositionHistory>,
}

#[derive(Debug, Serialize)]
pub struct LegacyReport {
    event_contract_version: i16,
    partial_transactions: i64,
    projected_positions: i64,
    signatures: [&'static str; 2],
}

pub async fn replay(database_url: &str) -> Result<FixtureReport> {
    let storage = Storage::connect(database_url).await?;
    storage.migrate().await?;
    let source = storage
        .ensure_source("fixture", "er", "fixture://phase-02")
        .await?;
    let start = "2026-07-24T12:00:00Z"
        .parse::<DateTime<Utc>>()
        .context("invalid fixture timestamp")?;
    let events = fixture_events(&source, start);

    for _ in 0..2 {
        for observation in &events {
            storage.apply(observation).await?;
        }
        storage
            .record_market_snapshot(
                &source,
                PROGRAM_ID,
                1,
                "6ME7jFHJkk27zAM7hz2A3V1Y4EeTkcjyZxnekQLtn8V1",
                9,
                "fixture-market-pool-hash",
                90_000_000,
                90_000_000,
            )
            .await?;
    }

    let transactions = count(&storage, "indexer.transactions", source.id).await?;
    let instructions = count(&storage, "indexer.instructions", source.id).await?;
    let positions = count(&storage, "indexer.positions", source.id).await?;
    let liquidity_events = count(&storage, "indexer.liquidity_events", source.id).await?;
    let fee_events = count(&storage, "indexer.fee_events", source.id).await?;
    let account_observations = count(&storage, "indexer.account_observations", source.id).await?;
    let (pool_balance, total_shares) = sqlx::query_as::<_, (i64, String)>(
        r#"
        SELECT pool_balance, total_shares::text
        FROM indexer.markets
        WHERE network = 'fixture' AND program_id = $1 AND market_id = 1
        "#,
    )
    .bind(PROGRAM_ID)
    .fetch_one(storage.pool())
    .await?;
    let total_shares_integer = total_shares.parse::<i128>()?;
    let lp_assets_from_snapshot = i64::try_from(
        i128::from(pool_balance)
            .checked_mul(90_000_000)
            .context("LP snapshot multiplication overflow")?
            / total_shares_integer,
    )?;
    let cursor = sqlx::query_scalar::<_, String>(
        "SELECT cursor_value FROM indexer.sync_cursors WHERE source_id = $1 AND datasource = 'fixture'",
    )
    .bind(source.id)
    .fetch_one(storage.pool())
    .await?;
    let history = storage
        .user_position_history("fixture", PROGRAM_ID, 1, USER)
        .await?;

    ensure!(transactions == 8, "fixture transaction count drifted");
    ensure!(instructions == 8, "fixture instruction count drifted");
    ensure!(positions == 1, "fixture position projection duplicated");
    ensure!(
        liquidity_events == 4,
        "fixture liquidity projection drifted"
    );
    ensure!(
        fee_events == 2,
        "fixture fee cash-movement projection drifted"
    );
    ensure!(account_observations == 1, "Market snapshot duplicated");
    ensure!(lp_assets_from_snapshot == 90_000_000);
    ensure!(
        cursor == "8",
        "cursor did not advance with projection writes"
    );
    ensure!(history.len() == 1, "terminal history row missing");
    let position = &history[0];
    ensure!(position.lifecycle_status == "settled");
    ensure!(position.outcome.as_deref() == Some("won"));
    ensure!(position.net_pnl == Some(900_000));
    ensure!(position.total_fee_amount == Some(100_000));
    ensure!(position.lp_fee_amount == Some(80_000));
    ensure!(position.platform_fee_amount == Some(20_000));

    Ok(FixtureReport {
        passes: 2,
        transactions,
        instructions,
        positions,
        liquidity_events,
        fee_events,
        account_observations,
        pool_balance,
        total_shares,
        lp_assets_from_snapshot,
        cursor,
        history,
    })
}

pub async fn record_legacy(database_url: &str) -> Result<LegacyReport> {
    let storage = Storage::connect(database_url).await?;
    storage.migrate().await?;
    let source = storage
        .ensure_source("devnet", "er", "https://devnet-as.magicblock.app/")
        .await?;
    for (label, signature) in [
        ("legacy_open", LEGACY_OPEN_SIGNATURE),
        ("legacy_settlement", LEGACY_SETTLEMENT_SIGNATURE),
    ] {
        storage
            .record_legacy_transaction(
                &source,
                signature,
                0,
                None,
                json!({
                    "fixture": label,
                    "position_projection": "not_fabricated",
                    "reason": "pre-v2 event contract lacks compact lifecycle fields"
                }),
            )
            .await?;
    }
    let partial_transactions = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM indexer.transactions WHERE source_id = $1 AND is_partial",
    )
    .bind(source.id)
    .fetch_one(storage.pool())
    .await?;
    let projected_positions = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM indexer.positions WHERE network = 'devnet' AND is_partial",
    )
    .fetch_one(storage.pool())
    .await?;
    ensure!(partial_transactions >= 2);
    ensure!(
        projected_positions == 0,
        "legacy fixtures must not fabricate position facts"
    );

    Ok(LegacyReport {
        event_contract_version: 1,
        partial_transactions,
        projected_positions,
        signatures: [LEGACY_OPEN_SIGNATURE, LEGACY_SETTLEMENT_SIGNATURE],
    })
}

fn fixture_events(source: &Source, start: DateTime<Utc>) -> Vec<Observation> {
    let event = |index: i64, signature: &str, event: DomainEvent| Observation {
        source: source.clone(),
        program_id: PROGRAM_ID.to_owned(),
        signature: signature.to_owned(),
        slot: index,
        block_time: Some(start + TimeDelta::seconds(index)),
        instruction_path: format!("0/{index}"),
        cursor_name: "fixture".to_owned(),
        cursor_value: index.to_string(),
        event,
    };
    vec![
        event(
            1,
            "fixture-open-v2",
            DomainEvent::PositionCreated {
                market_id: 1,
                position_id: 7,
                user: USER.to_owned(),
                entry_price: 100_000,
                collateral: 1_000_000,
                direction: Direction::Up,
                expires_at: u32::try_from(start.timestamp() + 10).unwrap(),
            },
        ),
        event(
            2,
            "fixture-close-v2",
            DomainEvent::PositionClosed {
                market_id: 1,
                position_id: 7,
                outcome: PositionOutcome::Won,
                payout_amount: 1_900_000,
                lp_fee_amount: 80_000,
                platform_fee_amount: 20_000,
            },
        ),
        event(
            3,
            "fixture-liquidity-deposit-v2",
            DomainEvent::LiquidityDeposited {
                market_id: 1,
                user: USER.to_owned(),
                assets: 100_000_000,
                shares: 100_000_000,
            },
        ),
        event(
            4,
            "fixture-withdrawal-request-v2",
            DomainEvent::WithdrawalRequested {
                market_id: 1,
                user: USER.to_owned(),
                shares: 10_000_000,
                min_assets_out: 9_000_000,
            },
        ),
        event(
            5,
            "fixture-withdrawal-execute-v2",
            DomainEvent::WithdrawalExecuted {
                market_id: 1,
                user: USER.to_owned(),
                shares: 10_000_000,
                assets: 10_000_000,
            },
        ),
        event(
            6,
            "fixture-protocol-fe-withdrawal-v2",
            DomainEvent::ProtocolFeesWithdrawn {
                market_id: 1,
                destination: DESTINATION.to_owned(),
                assets: 20_000,
            },
        ),
        event(
            7,
            "fixture-fallback-claim-v2",
            DomainEvent::FallbackPayoutClaimed {
                user: USER.to_owned(),
                destination: DESTINATION.to_owned(),
                assets: 50_000,
            },
        ),
        event(
            8,
            "fixture-withdrawal-cancel-v2",
            DomainEvent::WithdrawalCancelled {
                market_id: 1,
                user: USER.to_owned(),
                shares: 1,
            },
        ),
    ]
}

async fn count(storage: &Storage, table: &str, source_id: i64) -> Result<i64> {
    let allowed = [
        "indexer.transactions",
        "indexer.instructions",
        "indexer.positions",
        "indexer.liquidity_events",
        "indexer.fee_events",
        "indexer.account_observations",
    ];
    ensure!(allowed.contains(&table), "unsupported fixture table");
    let source_column = if table == "indexer.positions" {
        "created_source_id"
    } else {
        "source_id"
    };
    let query = format!("SELECT count(*) FROM {table} WHERE {source_column} = $1");
    Ok(sqlx::query_scalar::<_, i64>(&query)
        .bind(source_id)
        .fetch_one(storage.pool())
        .await?)
}
