use anyhow::{bail, Context, Result};
use carbon_leveraged_prediction_decoder::PROGRAM_ID;
use leveraged_prediction_storage::{Direction, DomainEvent, Observation, Source, Storage};
use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;

use crate::{
    cursors,
    reconcile::dead_letters::{self, FailureKind},
};

const SCENARIOS: &str = include_str!("../../../tests/recovery/scenarios.json");

#[derive(Debug, Deserialize)]
struct ScenarioManifest {
    scenarios: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RecoveryReport {
    scenarios: Vec<String>,
    rollback_observations: i64,
    rollback_cursors: i64,
    duplicate_dead_letters: i64,
    duplicate_dead_letter_attempts: i32,
    source_one_slot: i64,
    source_two_slot: i64,
    duplicate_positions: i64,
}

pub async fn verify(database_url: &str) -> Result<RecoveryReport> {
    let manifest: ScenarioManifest =
        serde_json::from_str(SCENARIOS).context("invalid recovery scenario manifest")?;
    let storage = Storage::connect(database_url).await?;
    storage.migrate().await?;
    let first = storage
        .ensure_source("recovery", "er", "http://recovery-source-one.invalid/")
        .await?;
    let second = storage
        .ensure_source("recovery", "er", "http://recovery-source-two.invalid/")
        .await?;
    reset(&storage, &[&first, &second]).await?;

    let mut fault = storage.pool().begin().await?;
    sqlx::query(
        r#"
        INSERT INTO indexer.account_observations (
            source_id, pubkey, slot, owner, data_hash, decoded_type
        )
        VALUES ($1, 'fault-account', 41, 'fault-owner', 'fault-hash', 'market')
        "#,
    )
    .bind(first.id)
    .execute(&mut *fault)
    .await?;
    cursors::advance(&mut fault, &first, "fault", "slot:41", 41, None).await?;
    fault.rollback().await?;

    let rollback_observations = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM indexer.account_observations WHERE source_id = $1",
    )
    .bind(first.id)
    .fetch_one(storage.pool())
    .await?;
    let rollback_cursors = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM indexer.sync_cursors WHERE source_id = $1 AND datasource = 'fault'",
    )
    .bind(first.id)
    .fetch_one(storage.pool())
    .await?;

    for _ in 0..2 {
        dead_letters::record(
            storage.pool(),
            &first,
            "dead-letter-signature",
            50,
            "log/1",
            FailureKind::UnknownDiscriminator,
            &[9; 16],
            serde_json::json!({ "fixture": true }),
        )
        .await?;
    }
    let (duplicate_dead_letters, duplicate_dead_letter_attempts) = sqlx::query_as::<_, (i64, i32)>(
        r#"
            SELECT count(*), max(attempts)
            FROM indexer.dead_letters
            WHERE source_id = $1 AND signature = 'dead-letter-signature'
            "#,
    )
    .bind(first.id)
    .fetch_one(storage.pool())
    .await?;

    storage
        .advance_cursor(&first, "ordering", "slot:100", 100, None)
        .await?;
    storage
        .advance_cursor(&first, "ordering", "slot:99", 99, None)
        .await?;
    storage
        .advance_cursor(&second, "ordering", "slot:100", 100, None)
        .await?;
    let source_one_slot = cursor_slot(&storage, &first, "ordering").await?;
    let source_two_slot = cursor_slot(&storage, &second, "ordering").await?;

    let observation = Observation {
        source: first.clone(),
        program_id: PROGRAM_ID.to_string(),
        signature: "recovery-position-signature".to_owned(),
        slot: 101,
        block_time: None,
        instruction_path: "log/0".to_owned(),
        cursor_name: "transactions".to_owned(),
        cursor_value: "recovery-position-signature".to_owned(),
        event: DomainEvent::PositionCreated {
            market_id: 1,
            position_id: 1,
            user: Pubkey::new_from_array([42; 32]).to_string(),
            entry_price: 100_000,
            collateral: 1_000_000,
            direction: Direction::Up,
            expires_at: 100,
        },
    };
    storage.apply(&observation).await?;
    storage.apply(&observation).await?;
    let duplicate_positions = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*) - count(DISTINCT (network, program_id, market_id, position_id))
        FROM indexer.positions
        WHERE network = 'recovery'
        "#,
    )
    .fetch_one(storage.pool())
    .await?;

    if rollback_observations != 0
        || rollback_cursors != 0
        || duplicate_dead_letters != 1
        || duplicate_dead_letter_attempts != 2
        || source_one_slot != 100
        || source_two_slot != 100
        || duplicate_positions != 0
    {
        bail!("recovery fixture invariant failed");
    }

    Ok(RecoveryReport {
        scenarios: manifest.scenarios,
        rollback_observations,
        rollback_cursors,
        duplicate_dead_letters,
        duplicate_dead_letter_attempts,
        source_one_slot,
        source_two_slot,
        duplicate_positions,
    })
}

async fn cursor_slot(storage: &Storage, source: &Source, name: &str) -> Result<i64> {
    storage
        .cursor(source.id, name)
        .await?
        .and_then(|(_, slot, _)| slot)
        .context("cursor has no slot")
}

async fn reset(storage: &Storage, sources: &[&Source]) -> Result<()> {
    let ids = sources.iter().map(|source| source.id).collect::<Vec<_>>();
    let mut tx = storage.pool().begin().await?;
    sqlx::query("DELETE FROM indexer.dead_letters WHERE source_id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.account_observations WHERE source_id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.instructions WHERE source_id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.transactions WHERE source_id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.positions WHERE network = 'recovery'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM indexer.sync_cursors WHERE source_id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
