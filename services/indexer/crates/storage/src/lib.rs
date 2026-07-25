use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use solana_pubkey::Pubkey;
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use std::str::FromStr;

pub const EVENT_CONTRACT_VERSION: i16 = 2;
pub const LEGACY_EVENT_CONTRACT_VERSION: i16 = 1;
pub const SCHEMA_MIGRATION_VERSION: i64 = 5;

#[derive(Clone)]
pub struct Storage {
    pool: PgPool,
}

#[derive(Clone, Debug)]
pub struct Source {
    pub id: i64,
    pub network: String,
    pub layer: String,
    pub endpoint: String,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub source: Source,
    pub program_id: String,
    pub signature: String,
    pub slot: i64,
    pub block_time: Option<DateTime<Utc>>,
    pub instruction_path: String,
    pub cursor_name: String,
    pub cursor_value: String,
    pub event: DomainEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DomainEvent {
    PositionCreated {
        market_id: u16,
        position_id: u32,
        user: String,
        entry_price: i64,
        collateral: u32,
        direction: Direction,
        expires_at: u32,
    },
    PositionClosed {
        market_id: u16,
        position_id: u32,
        outcome: PositionOutcome,
        payout_amount: u64,
        lp_fee_amount: u64,
        platform_fee_amount: u64,
    },
    LiquidityDeposited {
        market_id: u16,
        user: String,
        assets: u64,
        shares: u128,
    },
    WithdrawalRequested {
        market_id: u16,
        user: String,
        shares: u128,
        min_assets_out: u64,
    },
    WithdrawalCancelled {
        market_id: u16,
        user: String,
        shares: u128,
    },
    WithdrawalExecuted {
        market_id: u16,
        user: String,
        shares: u128,
        assets: u64,
    },
    ProtocolFeesWithdrawn {
        market_id: u16,
        destination: String,
        assets: u64,
    },
    FallbackPayoutClaimed {
        user: String,
        destination: String,
        assets: u64,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
}

impl Direction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionOutcome {
    Won,
    Lost,
    Breakeven,
    Refunded,
}

impl PositionOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Won => "won",
            Self::Lost => "lost",
            Self::Breakeven => "breakeven",
            Self::Refunded => "refunded",
        }
    }

    const fn lifecycle_status(self) -> &'static str {
        match self {
            Self::Refunded => "refunded",
            Self::Won | Self::Lost | Self::Breakeven => "settled",
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PositionHistory {
    pub market_id: i32,
    pub position_id: i64,
    pub user_pubkey: Option<String>,
    pub lifecycle_status: String,
    pub checkpoint_status: String,
    pub outcome: Option<String>,
    pub collateral: Option<i64>,
    pub payout_amount: Option<i64>,
    pub lp_fee_amount: Option<i64>,
    pub platform_fee_amount: Option<i64>,
    pub total_fee_amount: Option<i64>,
    pub net_pnl: Option<i64>,
    pub event_contract_version: i16,
    pub is_partial: bool,
}

impl Storage {
    pub async fn connect(database_url: &str) -> Result<Self> {
        Self::connect_with_max_connections(database_url, 5).await
    }

    pub async fn connect_with_max_connections(
        database_url: &str,
        max_connections: u32,
    ) -> Result<Self> {
        if max_connections == 0 {
            anyhow::bail!("database pool must allow at least one connection");
        }
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(database_url)
            .await
            .context("failed to connect to Postgres")?;
        Ok(Self { pool })
    }

    pub const fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("../../migrations")
            .run(&self.pool)
            .await
            .context("failed to apply indexer migrations")
    }

    pub async fn require_current_schema(&self) -> Result<()> {
        let version = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT max(version) FROM _sqlx_migrations WHERE success",
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to read schema migration version")?;
        if version != Some(SCHEMA_MIGRATION_VERSION) {
            anyhow::bail!(
                "database schema is at version {:?}; migration job must apply version {}",
                version,
                SCHEMA_MIGRATION_VERSION
            );
        }
        Ok(())
    }

    pub async fn ensure_source(
        &self,
        network: &str,
        layer: &str,
        endpoint: &str,
    ) -> Result<Source> {
        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO indexer.chain_sources (network, layer, endpoint)
            VALUES ($1, $2, $3)
            ON CONFLICT (network, layer, endpoint)
            DO UPDATE SET last_observed_at = now()
            RETURNING id
            "#,
        )
        .bind(network)
        .bind(layer)
        .bind(endpoint)
        .fetch_one(&self.pool)
        .await?;
        Ok(Source {
            id,
            network: network.to_owned(),
            layer: layer.to_owned(),
            endpoint: endpoint.to_owned(),
        })
    }

    pub async fn apply(&self, observation: &Observation) -> Result<()> {
        self.apply_batch(std::slice::from_ref(observation)).await
    }

    pub async fn apply_batch(&self, observations: &[Observation]) -> Result<()> {
        let Some(first) = observations.first() else {
            return Ok(());
        };
        if observations.iter().any(|observation| {
            observation.source.id != first.source.id
                || observation.signature != first.signature
                || observation.slot != first.slot
                || observation.cursor_name != first.cursor_name
                || observation.cursor_value != first.cursor_value
        }) {
            anyhow::bail!("one storage batch must belong to one source transaction and cursor");
        }
        let mut tx = self.pool.begin().await?;
        for observation in observations {
            insert_raw_observation(&mut tx, observation).await?;
            apply_projection(&mut tx, observation).await?;
        }
        advance_cursor(&mut tx, first).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn advance_cursor(
        &self,
        source: &Source,
        cursor_name: &str,
        cursor_value: &str,
        slot: i64,
        signature: Option<&str>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO indexer.sync_cursors (
                source_id, datasource, cursor_value, cursor_slot, cursor_signature
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (source_id, datasource)
            DO UPDATE SET
                cursor_value = EXCLUDED.cursor_value,
                cursor_slot = EXCLUDED.cursor_slot,
                cursor_signature = EXCLUDED.cursor_signature,
                updated_at = now()
            WHERE indexer.sync_cursors.cursor_slot IS NULL
               OR EXCLUDED.cursor_slot >= indexer.sync_cursors.cursor_slot
            "#,
        )
        .bind(source.id)
        .bind(cursor_name)
        .bind(cursor_value)
        .bind(slot)
        .bind(signature)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn cursor(
        &self,
        source_id: i64,
        cursor_name: &str,
    ) -> Result<Option<(String, Option<i64>, Option<String>)>> {
        Ok(sqlx::query_as::<_, (String, Option<i64>, Option<String>)>(
            r#"
            SELECT cursor_value, cursor_slot, cursor_signature
            FROM indexer.sync_cursors
            WHERE source_id = $1 AND datasource = $2
            "#,
        )
        .bind(source_id)
        .bind(cursor_name)
        .fetch_optional(&self.pool)
        .await?)
    }
}

async fn apply_projection(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
) -> Result<()> {
    match &observation.event {
        DomainEvent::PositionCreated {
            market_id,
            position_id,
            user,
            entry_price,
            collateral,
            direction,
            expires_at,
        } => {
            upsert_position_created(
                tx,
                observation,
                *market_id,
                *position_id,
                user,
                *entry_price,
                *collateral,
                *direction,
                *expires_at,
            )
            .await?;
            track_user_account(
                tx,
                observation,
                *market_id,
                user,
                "user_positions",
                b"user_positions",
            )
            .await?;
        }
        DomainEvent::PositionClosed {
            market_id,
            position_id,
            outcome,
            payout_amount,
            lp_fee_amount,
            platform_fee_amount,
        } => {
            upsert_position_closed(
                tx,
                observation,
                *market_id,
                *position_id,
                *outcome,
                *payout_amount,
                *lp_fee_amount,
                *platform_fee_amount,
            )
            .await?;
        }
        DomainEvent::LiquidityDeposited {
            market_id,
            user,
            assets,
            shares,
        } => {
            insert_liquidity_event(
                tx,
                observation,
                "deposit",
                *market_id,
                user,
                Some(*assets),
                *shares,
                None,
            )
            .await?;
            track_user_account(
                tx,
                observation,
                *market_id,
                user,
                "user_liquidity",
                b"user_liquidity",
            )
            .await?;
        }
        DomainEvent::WithdrawalRequested {
            market_id,
            user,
            shares,
            min_assets_out,
        } => {
            insert_liquidity_event(
                tx,
                observation,
                "withdrawal_requested",
                *market_id,
                user,
                None,
                *shares,
                Some(*min_assets_out),
            )
            .await?;
            track_user_account(
                tx,
                observation,
                *market_id,
                user,
                "user_liquidity",
                b"user_liquidity",
            )
            .await?;
        }
        DomainEvent::WithdrawalCancelled {
            market_id,
            user,
            shares,
        } => {
            insert_liquidity_event(
                tx,
                observation,
                "withdrawal_cancelled",
                *market_id,
                user,
                None,
                *shares,
                None,
            )
            .await?;
            track_user_account(
                tx,
                observation,
                *market_id,
                user,
                "user_liquidity",
                b"user_liquidity",
            )
            .await?;
        }
        DomainEvent::WithdrawalExecuted {
            market_id,
            user,
            shares,
            assets,
        } => {
            insert_liquidity_event(
                tx,
                observation,
                "withdrawal_executed",
                *market_id,
                user,
                Some(*assets),
                *shares,
                None,
            )
            .await?;
            track_user_account(
                tx,
                observation,
                *market_id,
                user,
                "user_liquidity",
                b"user_liquidity",
            )
            .await?;
        }
        DomainEvent::ProtocolFeesWithdrawn {
            market_id,
            destination,
            assets,
        } => {
            insert_fee_event(
                tx,
                observation,
                "protocol_withdrawal",
                Some(*market_id),
                None,
                destination,
                *assets,
            )
            .await?;
        }
        DomainEvent::FallbackPayoutClaimed {
            user,
            destination,
            assets,
        } => {
            insert_fee_event(
                tx,
                observation,
                "fallback_claim",
                None,
                Some(user),
                destination,
                *assets,
            )
            .await?;
        }
    }
    Ok(())
}

async fn track_user_account(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
    market_id: u16,
    user: &str,
    account_type: &str,
    seed: &[u8],
) -> Result<()> {
    let program_id = Pubkey::from_str(&observation.program_id)
        .context("observation program ID is not a valid pubkey")?;
    let user_pubkey = Pubkey::from_str(user).context("event user is not a valid pubkey")?;
    let (account, _) = Pubkey::find_program_address(&[seed, user_pubkey.as_ref()], &program_id);
    sqlx::query(
        r#"
        INSERT INTO indexer.tracked_accounts (
            network, program_id, pubkey, account_type, market_id, user_pubkey
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (network, program_id, pubkey)
        DO UPDATE SET
            account_type = EXCLUDED.account_type,
            market_id = EXCLUDED.market_id,
            user_pubkey = EXCLUDED.user_pubkey,
            updated_at = now()
        "#,
    )
    .bind(&observation.source.network)
    .bind(&observation.program_id)
    .bind(account.to_string())
    .bind(account_type)
    .bind(i32::from(market_id))
    .bind(user)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

impl Storage {
    pub async fn record_legacy_transaction(
        &self,
        source: &Source,
        signature: &str,
        slot: i64,
        block_time: Option<DateTime<Utc>>,
        raw_metadata: Value,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO indexer.transactions (
                source_id, signature, slot, block_time, succeeded,
                event_contract_version, is_partial, raw_metadata
            )
            VALUES ($1, $2, $3, $4, true, $5, true, $6)
            ON CONFLICT (source_id, signature) DO NOTHING
            "#,
        )
        .bind(source.id)
        .bind(signature)
        .bind(slot)
        .bind(block_time)
        .bind(LEGACY_EVENT_CONTRACT_VERSION)
        .bind(raw_metadata)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn record_market_snapshot(
        &self,
        source: &Source,
        program_id: &str,
        market_id: u16,
        market_pubkey: &str,
        slot: i64,
        data_hash: &str,
        total_shares: u128,
        pool_balance: u64,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO indexer.account_observations (
                source_id, pubkey, slot, owner, data_hash, decoded_type, decoded_payload
            )
            VALUES (
                $1, $2, $3, $4, $5, 'market_pool_snapshot',
                jsonb_build_object('total_shares', $6::text, 'pool_balance', $7)
            )
            ON CONFLICT (source_id, pubkey, slot, data_hash) DO NOTHING
            "#,
        )
        .bind(source.id)
        .bind(market_pubkey)
        .bind(slot)
        .bind(program_id)
        .bind(data_hash)
        .bind(total_shares.to_string())
        .bind(i64::try_from(pool_balance).context("pool balance exceeds Postgres BIGINT")?)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO indexer.markets (
                network, program_id, market_id, market_pubkey, total_shares,
                pool_balance, last_source_id, last_slot
            )
            VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)
            ON CONFLICT (network, program_id, market_id)
            DO UPDATE SET
                market_pubkey = EXCLUDED.market_pubkey,
                total_shares = EXCLUDED.total_shares,
                pool_balance = EXCLUDED.pool_balance,
                last_source_id = EXCLUDED.last_source_id,
                last_slot = EXCLUDED.last_slot,
                updated_at = now()
            WHERE indexer.markets.last_slot IS NULL
               OR EXCLUDED.last_slot >= indexer.markets.last_slot
            "#,
        )
        .bind(&source.network)
        .bind(program_id)
        .bind(i32::from(market_id))
        .bind(market_pubkey)
        .bind(total_shares.to_string())
        .bind(i64::try_from(pool_balance).context("pool balance exceeds Postgres BIGINT")?)
        .bind(source.id)
        .bind(slot)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn user_position_history(
        &self,
        network: &str,
        program_id: &str,
        market_id: u16,
        user: &str,
    ) -> Result<Vec<PositionHistory>> {
        Ok(sqlx::query_as::<_, PositionHistory>(
            r#"
            SELECT
                market_id, position_id, user_pubkey, lifecycle_status, outcome,
                checkpoint_status,
                collateral, payout_amount, lp_fee_amount, platform_fee_amount,
                total_fee_amount, net_pnl, event_contract_version, is_partial
            FROM indexer.position_history
            WHERE network = $1
              AND program_id = $2
              AND market_id = $3
              AND user_pubkey = $4
            ORDER BY position_id DESC
            "#,
        )
        .bind(network)
        .bind(program_id)
        .bind(i32::from(market_id))
        .bind(user)
        .fetch_all(&self.pool)
        .await?)
    }
}

async fn insert_raw_observation(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO indexer.transactions (
            source_id, signature, slot, block_time, succeeded,
            event_contract_version, is_partial
        )
        VALUES ($1, $2, $3, $4, true, $5, false)
        ON CONFLICT (source_id, signature) DO NOTHING
        "#,
    )
    .bind(observation.source.id)
    .bind(&observation.signature)
    .bind(observation.slot)
    .bind(observation.block_time)
    .bind(EVENT_CONTRACT_VERSION)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO indexer.instructions (
            source_id, signature, instruction_path, program_id, decoded_variant,
            normalized_payload, event_contract_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (source_id, signature, instruction_path, decoded_variant) DO NOTHING
        "#,
    )
    .bind(observation.source.id)
    .bind(&observation.signature)
    .bind(&observation.instruction_path)
    .bind(&observation.program_id)
    .bind(event_name(&observation.event))
    .bind(serde_json::to_value(&observation.event)?)
    .bind(EVENT_CONTRACT_VERSION)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_position_created(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
    market_id: u16,
    position_id: u32,
    user: &str,
    entry_price: i64,
    collateral: u32,
    direction: Direction,
    expires_at: u32,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO indexer.positions (
            network, program_id, market_id, position_id, user_pubkey, entry_price,
            collateral, direction, expires_at, lifecycle_status, opened_at,
            event_contract_version, is_partial, created_source_id, created_signature, last_slot
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9),
            'open', to_timestamp($9 - 10), $10, false, $11, $12, $13
        )
        ON CONFLICT (network, program_id, market_id, position_id)
        DO UPDATE SET
            user_pubkey = EXCLUDED.user_pubkey,
            entry_price = EXCLUDED.entry_price,
            collateral = EXCLUDED.collateral,
            direction = EXCLUDED.direction,
            expires_at = EXCLUDED.expires_at,
            opened_at = EXCLUDED.opened_at,
            created_source_id = EXCLUDED.created_source_id,
            created_signature = EXCLUDED.created_signature,
            event_contract_version = GREATEST(
                indexer.positions.event_contract_version,
                EXCLUDED.event_contract_version
            ),
            is_partial = false,
            last_slot = GREATEST(indexer.positions.last_slot, EXCLUDED.last_slot),
            updated_at = now()
        WHERE (
            indexer.positions.user_pubkey,
            indexer.positions.entry_price,
            indexer.positions.collateral,
            indexer.positions.direction,
            indexer.positions.expires_at,
            indexer.positions.opened_at,
            indexer.positions.created_source_id,
            indexer.positions.created_signature,
            indexer.positions.event_contract_version,
            indexer.positions.is_partial,
            indexer.positions.last_slot
        ) IS DISTINCT FROM (
            EXCLUDED.user_pubkey,
            EXCLUDED.entry_price,
            EXCLUDED.collateral,
            EXCLUDED.direction,
            EXCLUDED.expires_at,
            EXCLUDED.opened_at,
            EXCLUDED.created_source_id,
            EXCLUDED.created_signature,
            EXCLUDED.event_contract_version,
            false,
            GREATEST(indexer.positions.last_slot, EXCLUDED.last_slot)
        )
        "#,
    )
    .bind(&observation.source.network)
    .bind(&observation.program_id)
    .bind(i32::from(market_id))
    .bind(i64::from(position_id))
    .bind(user)
    .bind(entry_price)
    .bind(i64::from(collateral))
    .bind(direction.as_str())
    .bind(i64::from(expires_at))
    .bind(EVENT_CONTRACT_VERSION)
    .bind(observation.source.id)
    .bind(&observation.signature)
    .bind(observation.slot)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_position_closed(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
    market_id: u16,
    position_id: u32,
    outcome: PositionOutcome,
    payout_amount: u64,
    lp_fee_amount: u64,
    platform_fee_amount: u64,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO indexer.positions (
            network, program_id, market_id, position_id, lifecycle_status, outcome,
            payout_amount, lp_fee_amount, platform_fee_amount, closed_at,
            event_contract_version, is_partial, closed_source_id, closed_signature, last_slot
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $14)
        ON CONFLICT (network, program_id, market_id, position_id)
        DO UPDATE SET
            lifecycle_status = EXCLUDED.lifecycle_status,
            outcome = EXCLUDED.outcome,
            payout_amount = EXCLUDED.payout_amount,
            lp_fee_amount = EXCLUDED.lp_fee_amount,
            platform_fee_amount = EXCLUDED.platform_fee_amount,
            closed_at = COALESCE(indexer.positions.closed_at, EXCLUDED.closed_at),
            closed_source_id = EXCLUDED.closed_source_id,
            closed_signature = EXCLUDED.closed_signature,
            event_contract_version = GREATEST(
                indexer.positions.event_contract_version,
                EXCLUDED.event_contract_version
            ),
            is_partial = indexer.positions.user_pubkey IS NULL,
            last_slot = GREATEST(indexer.positions.last_slot, EXCLUDED.last_slot),
            updated_at = now()
        WHERE (
            indexer.positions.lifecycle_status,
            indexer.positions.outcome,
            indexer.positions.payout_amount,
            indexer.positions.lp_fee_amount,
            indexer.positions.platform_fee_amount,
            indexer.positions.closed_source_id,
            indexer.positions.closed_signature,
            indexer.positions.event_contract_version,
            indexer.positions.is_partial,
            indexer.positions.last_slot
        ) IS DISTINCT FROM (
            EXCLUDED.lifecycle_status,
            EXCLUDED.outcome,
            EXCLUDED.payout_amount,
            EXCLUDED.lp_fee_amount,
            EXCLUDED.platform_fee_amount,
            EXCLUDED.closed_source_id,
            EXCLUDED.closed_signature,
            EXCLUDED.event_contract_version,
            indexer.positions.user_pubkey IS NULL,
            GREATEST(indexer.positions.last_slot, EXCLUDED.last_slot)
        )
        "#,
    )
    .bind(&observation.source.network)
    .bind(&observation.program_id)
    .bind(i32::from(market_id))
    .bind(i64::from(position_id))
    .bind(outcome.lifecycle_status())
    .bind(outcome.as_str())
    .bind(i64::try_from(payout_amount).context("payout exceeds Postgres BIGINT")?)
    .bind(i64::try_from(lp_fee_amount).context("LP fee exceeds Postgres BIGINT")?)
    .bind(i64::try_from(platform_fee_amount).context("platform fee exceeds Postgres BIGINT")?)
    .bind(observation.block_time)
    .bind(EVENT_CONTRACT_VERSION)
    .bind(observation.source.id)
    .bind(&observation.signature)
    .bind(observation.slot)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_liquidity_event(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
    kind: &str,
    market_id: u16,
    user: &str,
    assets: Option<u64>,
    shares: u128,
    min_assets_out: Option<u64>,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO indexer.liquidity_events (
            source_id, signature, instruction_path, event_kind, network, program_id,
            market_id, user_pubkey, assets, shares, min_assets_out, occurred_at,
            event_contract_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12, $13)
        ON CONFLICT (source_id, signature, instruction_path, event_kind) DO NOTHING
        "#,
    )
    .bind(observation.source.id)
    .bind(&observation.signature)
    .bind(&observation.instruction_path)
    .bind(kind)
    .bind(&observation.source.network)
    .bind(&observation.program_id)
    .bind(i32::from(market_id))
    .bind(user)
    .bind(assets.map(i64::try_from).transpose()?)
    .bind(shares.to_string())
    .bind(min_assets_out.map(i64::try_from).transpose()?)
    .bind(observation.block_time)
    .bind(EVENT_CONTRACT_VERSION)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_fee_event(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
    kind: &str,
    market_id: Option<u16>,
    user: Option<&String>,
    destination: &str,
    assets: u64,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO indexer.fee_events (
            source_id, signature, instruction_path, event_kind, network, program_id,
            market_id, user_pubkey, destination, assets, occurred_at, event_contract_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (source_id, signature, instruction_path, event_kind) DO NOTHING
        "#,
    )
    .bind(observation.source.id)
    .bind(&observation.signature)
    .bind(&observation.instruction_path)
    .bind(kind)
    .bind(&observation.source.network)
    .bind(&observation.program_id)
    .bind(market_id.map(i32::from))
    .bind(user)
    .bind(destination)
    .bind(i64::try_from(assets).context("fee event amount exceeds Postgres BIGINT")?)
    .bind(observation.block_time)
    .bind(EVENT_CONTRACT_VERSION)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn advance_cursor(
    tx: &mut Transaction<'_, Postgres>,
    observation: &Observation,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO indexer.sync_cursors (
            source_id, datasource, cursor_value, cursor_slot, cursor_signature
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (source_id, datasource)
        DO UPDATE SET
            cursor_value = EXCLUDED.cursor_value,
            cursor_slot = EXCLUDED.cursor_slot,
            cursor_signature = EXCLUDED.cursor_signature,
            updated_at = now()
        WHERE indexer.sync_cursors.cursor_slot IS NULL
           OR EXCLUDED.cursor_slot >= indexer.sync_cursors.cursor_slot
        "#,
    )
    .bind(observation.source.id)
    .bind(&observation.cursor_name)
    .bind(&observation.cursor_value)
    .bind(observation.slot)
    .bind(&observation.signature)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

const fn event_name(event: &DomainEvent) -> &'static str {
    match event {
        DomainEvent::PositionCreated { .. } => "position_created",
        DomainEvent::PositionClosed { .. } => "position_closed",
        DomainEvent::LiquidityDeposited { .. } => "liquidity_deposited",
        DomainEvent::WithdrawalRequested { .. } => "withdrawal_requested",
        DomainEvent::WithdrawalCancelled { .. } => "withdrawal_cancelled",
        DomainEvent::WithdrawalExecuted { .. } => "withdrawal_executed",
        DomainEvent::ProtocolFeesWithdrawn { .. } => "protocol_fees_withdrawn",
        DomainEvent::FallbackPayoutClaimed { .. } => "fallback_payout_claimed",
    }
}
