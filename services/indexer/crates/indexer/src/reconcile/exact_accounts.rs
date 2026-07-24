use std::collections::BTreeSet;

use anyhow::{Context, Result};
use carbon_leveraged_prediction_decoder::accounts::{
    market::Market, user_liquidity::UserLiquidity, user_positions::UserPositions,
};
use leveraged_prediction_storage::{Source, Storage};
use serde::Serialize;
use sha2::{Digest, Sha256};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use sqlx::{Postgres, Transaction};

use crate::cursors;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackedAccountType {
    Market,
    UserPositions,
    UserLiquidity,
}

impl TrackedAccountType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Market => "market",
            Self::UserPositions => "user_positions",
            Self::UserLiquidity => "user_liquidity",
        }
    }

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "market" => Ok(Self::Market),
            "user_positions" => Ok(Self::UserPositions),
            "user_liquidity" => Ok(Self::UserLiquidity),
            _ => anyhow::bail!("unsupported tracked account type {value}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrackedAccount {
    pub pubkey: Pubkey,
    pub account_type: TrackedAccountType,
    pub market_id: Option<u16>,
    pub user_pubkey: Option<Pubkey>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
enum DecodedAccount {
    Market(Market),
    UserPositions(UserPositions),
    UserLiquidity(UserLiquidity),
}

#[derive(Debug, Serialize)]
pub struct ReconcileReport {
    pub source_id: i64,
    pub slot: u64,
    pub accounts_requested: usize,
    pub accounts_found: usize,
    pub observations_inserted: u64,
}

pub async fn load_tracked(
    storage: &Storage,
    network: &str,
    program_id: &Pubkey,
) -> Result<Vec<TrackedAccount>> {
    let rows = sqlx::query_as::<_, (String, String, Option<i32>, Option<String>)>(
        r#"
        SELECT pubkey, account_type, market_id, user_pubkey
        FROM indexer.tracked_accounts
        WHERE network = $1 AND program_id = $2
        ORDER BY pubkey
        "#,
    )
    .bind(network)
    .bind(program_id.to_string())
    .fetch_all(storage.pool())
    .await?;
    rows.into_iter()
        .map(
            |(pubkey, account_type, market_id, user_pubkey)| -> Result<TrackedAccount> {
                Ok(TrackedAccount {
                    pubkey: pubkey.parse().context("invalid tracked account pubkey")?,
                    account_type: TrackedAccountType::from_str(&account_type)?,
                    market_id: market_id
                        .map(u16::try_from)
                        .transpose()
                        .context("tracked market ID exceeds u16")?,
                    user_pubkey: user_pubkey
                        .map(|value| value.parse())
                        .transpose()
                        .context("invalid tracked user pubkey")?,
                })
            },
        )
        .collect()
}

pub async fn reconcile(
    storage: &Storage,
    source: &Source,
    endpoint: &str,
    program_id: &Pubkey,
    accounts: &[TrackedAccount],
) -> Result<ReconcileReport> {
    let client = RpcClient::new_with_commitment(endpoint.to_owned(), CommitmentConfig::confirmed());
    let pubkeys = accounts.iter().map(|item| item.pubkey).collect::<Vec<_>>();
    let response = client
        .get_multiple_accounts_with_commitment(&pubkeys, CommitmentConfig::confirmed())
        .await
        .context("exact-account reconciliation RPC failed")?;
    let slot = i64::try_from(response.context.slot).context("slot exceeds Postgres BIGINT")?;

    let mut tx = storage.pool().begin().await?;
    let run_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO indexer.reconciliation_runs (
            source_id, datasource, observed_slot, accounts_requested
        )
        VALUES ($1, 'exact_accounts', $2, $3)
        RETURNING id
        "#,
    )
    .bind(source.id)
    .bind(slot)
    .bind(i32::try_from(accounts.len()).context("too many tracked accounts")?)
    .fetch_one(&mut *tx)
    .await?;

    let mut accounts_found = 0_u64;
    let mut observations_inserted = 0_u64;
    for (tracked, account) in accounts.iter().zip(response.value) {
        let Some(account) = account else {
            continue;
        };
        accounts_found += 1;
        let decoded = decode(tracked.account_type, &account.data)
            .with_context(|| format!("failed to decode tracked account {}", tracked.pubkey))?;
        let data_hash = hex::encode(Sha256::digest(&account.data));
        let inserted = insert_observation(
            &mut tx,
            source,
            tracked,
            slot,
            &account.owner.to_string(),
            &data_hash,
            &decoded,
        )
        .await?;
        observations_inserted += inserted;
        apply_projection(&mut tx, source, tracked, slot, program_id, &decoded).await?;
    }

    let cursor_value = format!("slot:{slot}");
    cursors::advance(&mut tx, source, "exact_accounts", &cursor_value, slot, None).await?;
    sqlx::query(
        r#"
        UPDATE indexer.reconciliation_runs
        SET
            completed_at = now(),
            accounts_found = $2,
            observations_inserted = $3
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(i32::try_from(accounts_found)?)
    .bind(i32::try_from(observations_inserted)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(ReconcileReport {
        source_id: source.id,
        slot: response.context.slot,
        accounts_requested: accounts.len(),
        accounts_found: usize::try_from(accounts_found)?,
        observations_inserted,
    })
}

fn decode(account_type: TrackedAccountType, data: &[u8]) -> Option<DecodedAccount> {
    match account_type {
        TrackedAccountType::Market => Market::decode(data).map(DecodedAccount::Market),
        TrackedAccountType::UserPositions => {
            UserPositions::decode(data).map(DecodedAccount::UserPositions)
        }
        TrackedAccountType::UserLiquidity => {
            UserLiquidity::decode(data).map(DecodedAccount::UserLiquidity)
        }
    }
}

async fn insert_observation(
    tx: &mut Transaction<'_, Postgres>,
    source: &Source,
    tracked: &TrackedAccount,
    slot: i64,
    owner: &str,
    data_hash: &str,
    decoded: &DecodedAccount,
) -> Result<u64> {
    let result = sqlx::query(
        r#"
        INSERT INTO indexer.account_observations (
            source_id, pubkey, slot, owner, data_hash, decoded_type, decoded_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (source_id, pubkey, slot, data_hash) DO NOTHING
        "#,
    )
    .bind(source.id)
    .bind(tracked.pubkey.to_string())
    .bind(slot)
    .bind(owner)
    .bind(data_hash)
    .bind(tracked.account_type.as_str())
    .bind(serde_json::to_value(decoded)?)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

async fn apply_projection(
    tx: &mut Transaction<'_, Postgres>,
    source: &Source,
    tracked: &TrackedAccount,
    slot: i64,
    program_id: &Pubkey,
    decoded: &DecodedAccount,
) -> Result<()> {
    match decoded {
        DecodedAccount::Market(market) => {
            sqlx::query(
                r#"
                INSERT INTO indexer.markets (
                    network, program_id, market_id, market_pubkey, mode, total_shares,
                    open_collateral, active_positions, last_source_id, last_slot
                )
                VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10)
                ON CONFLICT (network, program_id, market_id)
                DO UPDATE SET
                    market_pubkey = EXCLUDED.market_pubkey,
                    mode = EXCLUDED.mode,
                    total_shares = EXCLUDED.total_shares,
                    open_collateral = EXCLUDED.open_collateral,
                    active_positions = EXCLUDED.active_positions,
                    last_source_id = EXCLUDED.last_source_id,
                    last_slot = EXCLUDED.last_slot,
                    updated_at = now()
                WHERE indexer.markets.last_source_id IS NULL
                   OR (
                        indexer.markets.last_source_id = EXCLUDED.last_source_id
                        AND (
                            indexer.markets.last_slot IS NULL
                            OR EXCLUDED.last_slot >= indexer.markets.last_slot
                        )
                   )
                   OR (
                        (
                            SELECT layer
                            FROM indexer.chain_sources
                            WHERE id = indexer.markets.last_source_id
                        ) = 'base'
                        AND (
                            SELECT layer
                            FROM indexer.chain_sources
                            WHERE id = EXCLUDED.last_source_id
                        ) = 'er'
                   )
                "#,
            )
            .bind(&source.network)
            .bind(program_id.to_string())
            .bind(i32::from(market.market_id))
            .bind(tracked.pubkey.to_string())
            .bind(format!("{:?}", market.mode).to_lowercase())
            .bind(market.total_shares.to_string())
            .bind(i64::try_from(market.open_collateral)?)
            .bind(i32::try_from(market.active_positions)?)
            .bind(source.id)
            .bind(slot)
            .execute(&mut **tx)
            .await?;
        }
        DecodedAccount::UserPositions(user_positions) => {
            let Some(user) = tracked.user_pubkey else {
                return Ok(());
            };
            let Some(market_id) = tracked.market_id else {
                return Ok(());
            };
            let active = user_positions
                .positions
                .iter()
                .filter(|position| position.market_id == market_id)
                .map(|position| i64::from(position.nonce))
                .collect::<BTreeSet<_>>();
            let active_ids = active.into_iter().collect::<Vec<_>>();
            sqlx::query(
                r#"
                UPDATE indexer.positions
                SET
                    checkpoint_status = 'base_observed',
                    base_checkpoint_source_id = $1,
                    base_checkpoint_slot = $2,
                    base_checkpoint_observed_at = now(),
                    updated_at = now()
                WHERE network = $3
                  AND program_id = $4
                  AND market_id = $5
                  AND user_pubkey = $6
                  AND lifecycle_status IN ('settled', 'refunded')
                  AND NOT (position_id = ANY($7))
                  AND (
                    base_checkpoint_slot IS NULL
                    OR $2 >= base_checkpoint_slot
                  )
                "#,
            )
            .bind(source.id)
            .bind(slot)
            .bind(&source.network)
            .bind(program_id.to_string())
            .bind(i32::from(market_id))
            .bind(user.to_string())
            .bind(active_ids)
            .execute(&mut **tx)
            .await?;
        }
        DecodedAccount::UserLiquidity(_) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_duplicate_account_data_has_a_stable_hash() {
        let data = b"same account bytes";
        let first = hex::encode(Sha256::digest(data));
        let second = hex::encode(Sha256::digest(data));
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }
}
