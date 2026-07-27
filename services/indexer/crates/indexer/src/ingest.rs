use std::str::FromStr;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use carbon_leveraged_prediction_decoder::{
    events::{
        fallback_payout_claimed::FallbackPayoutClaimedEvent,
        liquidity_deposited::LiquidityDepositedEvent, market_mode_changed::MarketModeChangedEvent,
        position_closed::PositionClosedEvent, position_created::PositionCreatedEvent,
        protocol_fees_withdrawn::ProtocolFeesWithdrawnEvent,
        withdrawal_cancelled::WithdrawalCancelledEvent,
        withdrawal_executed::WithdrawalExecutedEvent,
        withdrawal_requested::WithdrawalRequestedEvent,
    },
    types::{Direction as CarbonDirection, PositionOutcome as CarbonPositionOutcome},
    PROGRAM_ID,
};
use chrono::{DateTime, Utc};
use leveraged_prediction_storage::{Direction, DomainEvent, Observation, PositionOutcome, Storage};
use serde::Serialize;
use solana_client::{
    nonblocking::rpc_client::RpcClient, rpc_client::GetConfirmedSignaturesForAddress2Config,
    rpc_config::RpcTransactionConfig,
};
use solana_commitment_config::CommitmentConfig;
use solana_signature::Signature;
use solana_transaction_status::{option_serializer::OptionSerializer, UiTransactionEncoding};

use crate::reconcile::dead_letters::{self, FailureKind};

pub const EVENT_CURSOR: &str = "transaction_crawler";

#[derive(Debug, Serialize)]
pub struct IngestReport {
    source_id: i64,
    pub cursor_before: Option<String>,
    pub cursor_found: bool,
    overlap_transactions: usize,
    pub transactions_scanned: usize,
    successful_transactions: usize,
    pre_v2_transactions_skipped: usize,
    pub domain_events_applied: usize,
    first_signature: Option<String>,
    last_signature: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LiveIngestReport {
    pub events_applied: usize,
    pub failed_transaction: bool,
    pub pre_v2_transaction: bool,
}

pub async fn recent(
    database_url: &str,
    network: &str,
    layer: &str,
    endpoint: &str,
    limit: usize,
    v2_min_slot: u64,
) -> Result<IngestReport> {
    let storage = Storage::connect(database_url).await?;
    storage.migrate().await?;
    recent_with_storage(&storage, network, layer, endpoint, limit, v2_min_slot).await
}

pub async fn recent_with_storage(
    storage: &Storage,
    network: &str,
    layer: &str,
    endpoint: &str,
    limit: usize,
    v2_min_slot: u64,
) -> Result<IngestReport> {
    let source = storage.ensure_source(network, layer, endpoint).await?;
    let client = RpcClient::new_with_commitment(endpoint.to_owned(), CommitmentConfig::confirmed());
    let cursor_before = storage
        .cursor(source.id, EVENT_CURSOR)
        .await?
        .and_then(|(_, _, signature)| signature);
    let maximum = limit.clamp(1, 10_000);
    let page_size = maximum.min(1_000);
    let mut before = None;
    let mut signatures = Vec::new();
    let mut cursor_found = false;
    let mut overlap_transactions = 0_usize;
    const OVERLAP: usize = 32;
    'crawl: loop {
        let page = client
            .get_signatures_for_address_with_config(
                &PROGRAM_ID,
                GetConfirmedSignaturesForAddress2Config {
                    before,
                    until: None,
                    limit: Some(page_size),
                    commitment: Some(CommitmentConfig::confirmed()),
                },
            )
            .await
            .context("failed to crawl program signatures")?;
        if page.is_empty() {
            break;
        }
        let page_len = page.len();
        before = page
            .last()
            .map(|item| Signature::from_str(&item.signature))
            .transpose()
            .context("RPC returned an invalid pagination signature")?;
        for item in page {
            if signatures.len() >= maximum {
                break 'crawl;
            }
            if cursor_before.as_deref() == Some(item.signature.as_str()) {
                cursor_found = true;
            } else if cursor_found {
                overlap_transactions += 1;
                if overlap_transactions > OVERLAP {
                    break 'crawl;
                }
            }
            signatures.push(item);
        }
        if page_len < page_size {
            break;
        }
    }
    let first_signature = signatures.last().map(|item| item.signature.clone());
    let last_signature = signatures.first().map(|item| item.signature.clone());
    let mut successful_transactions = 0;
    let mut pre_v2_transactions_skipped = 0;
    let mut domain_events_applied = 0;

    for signature_info in signatures.iter().rev() {
        if signature_info.err.is_some() {
            continue;
        }
        let signature = Signature::from_str(&signature_info.signature)
            .context("RPC returned an invalid signature")?;
        let transaction = client
            .get_transaction_with_config(
                &signature,
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::Base64),
                    commitment: Some(CommitmentConfig::confirmed()),
                    max_supported_transaction_version: Some(0),
                },
            )
            .await
            .with_context(|| format!("failed to fetch transaction {signature}"))?;
        let Some(meta) = transaction.transaction.meta else {
            continue;
        };
        if meta.err.is_some() {
            continue;
        }
        successful_transactions += 1;
        let slot =
            i64::try_from(transaction.slot).context("transaction slot exceeds Postgres BIGINT")?;
        if transaction.slot < v2_min_slot {
            pre_v2_transactions_skipped += 1;
            storage
                .advance_cursor(
                    &source,
                    EVENT_CURSOR,
                    &signature.to_string(),
                    slot,
                    Some(&signature.to_string()),
                )
                .await?;
            continue;
        }
        let block_time = transaction
            .block_time
            .and_then(|timestamp| DateTime::<Utc>::from_timestamp(timestamp, 0));
        let logs = match meta.log_messages {
            OptionSerializer::Some(logs) => logs,
            OptionSerializer::None | OptionSerializer::Skip => Vec::new(),
        };
        domain_events_applied += apply_program_logs(
            storage,
            &source,
            &signature.to_string(),
            slot,
            block_time,
            &logs,
        )
        .await?;
    }

    Ok(IngestReport {
        source_id: source.id,
        cursor_before,
        cursor_found,
        overlap_transactions,
        transactions_scanned: signatures.len(),
        successful_transactions,
        pre_v2_transactions_skipped,
        domain_events_applied,
        first_signature,
        last_signature,
    })
}

pub async fn logs_with_storage(
    storage: &Storage,
    source: &leveraged_prediction_storage::Source,
    signature: &str,
    slot: u64,
    failed_transaction: bool,
    logs: &[String],
    observed_at: DateTime<Utc>,
    v2_min_slot: u64,
) -> Result<LiveIngestReport> {
    let signature = Signature::from_str(signature)
        .context("logsSubscribe returned an invalid transaction signature")?
        .to_string();
    let pre_v2_transaction = slot < v2_min_slot;
    let slot = i64::try_from(slot).context("logsSubscribe slot exceeds Postgres BIGINT")?;
    if failed_transaction || pre_v2_transaction {
        storage
            .advance_cursor(source, EVENT_CURSOR, &signature, slot, Some(&signature))
            .await?;
        return Ok(LiveIngestReport {
            events_applied: 0,
            failed_transaction,
            pre_v2_transaction: !failed_transaction && pre_v2_transaction,
        });
    }
    let events_applied =
        apply_program_logs(storage, source, &signature, slot, Some(observed_at), logs).await?;
    Ok(LiveIngestReport {
        events_applied,
        failed_transaction: false,
        pre_v2_transaction: false,
    })
}

async fn apply_program_logs(
    storage: &Storage,
    source: &leveraged_prediction_storage::Source,
    signature: &str,
    slot: i64,
    block_time: Option<DateTime<Utc>>,
    logs: &[String],
) -> Result<usize> {
    let mut observations = Vec::new();
    for (log_index, encoded) in program_data_logs(logs, &PROGRAM_ID.to_string()) {
        let instruction_path = format!("log/{log_index}");
        let data = match STANDARD.decode(encoded) {
            Ok(data) => data,
            Err(error) => {
                dead_letters::record(
                    storage.pool(),
                    source,
                    signature,
                    slot,
                    &instruction_path,
                    FailureKind::MalformedPayload,
                    encoded.as_bytes(),
                    serde_json::json!({ "error": error.to_string(), "encoding": "base64" }),
                )
                .await?;
                continue;
            }
        };
        match decode_event(&data) {
            Ok(Some(event)) => {
                observations.push(Observation {
                    source: source.clone(),
                    program_id: PROGRAM_ID.to_string(),
                    signature: signature.to_owned(),
                    slot,
                    block_time,
                    instruction_path,
                    cursor_name: EVENT_CURSOR.to_owned(),
                    cursor_value: signature.to_owned(),
                    event,
                });
            }
            Ok(None) => {}
            Err(kind) => {
                dead_letters::record(
                    storage.pool(),
                    source,
                    signature,
                    slot,
                    &instruction_path,
                    kind,
                    &data,
                    serde_json::json!({ "event_contract_version": 2 }),
                )
                .await?;
            }
        }
    }
    let events_applied = observations.len();
    if observations.is_empty() {
        storage
            .advance_cursor(source, EVENT_CURSOR, signature, slot, Some(signature))
            .await?;
    } else {
        storage.apply_batch(&observations).await?;
    }
    Ok(events_applied)
}

fn decode_event(data: &[u8]) -> std::result::Result<Option<DomainEvent>, FailureKind> {
    let discriminator: [u8; 8] = data
        .get(..8)
        .ok_or(FailureKind::MalformedPayload)?
        .try_into()
        .map_err(|_| FailureKind::MalformedPayload)?;
    if discriminator == [63, 226, 54, 63, 141, 22, 31, 221] {
        let event = PositionCreatedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::PositionCreated {
            market_id: event.market_id,
            position_id: event.position_id,
            user: event.user.to_string(),
            entry_price: event.entry_price,
            collateral: event.collateral,
            direction: match event.direction {
                CarbonDirection::Up => Direction::Up,
                CarbonDirection::Down => Direction::Down,
            },
            expires_at: event.expires_at,
        }));
    }
    if discriminator == [157, 163, 227, 228, 13, 97, 138, 121] {
        let event = PositionClosedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::PositionClosed {
            market_id: event.market_id,
            position_id: event.position_id,
            outcome: match event.outcome {
                CarbonPositionOutcome::Won => PositionOutcome::Won,
                CarbonPositionOutcome::Lost => PositionOutcome::Lost,
                CarbonPositionOutcome::Breakeven => PositionOutcome::Breakeven,
                CarbonPositionOutcome::Refunded => PositionOutcome::Refunded,
            },
            payout_amount: event.payout_amount,
            lp_fee_amount: event.lp_fee_amount,
            platform_fee_amount: event.platform_fee_amount,
        }));
    }
    if discriminator == [218, 155, 74, 193, 59, 66, 94, 122] {
        let event = LiquidityDepositedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::LiquidityDeposited {
            market_id: event.market_id,
            user: event.user.to_string(),
            assets: event.assets,
            shares: event.shares,
        }));
    }
    if discriminator == [75, 207, 21, 12, 160, 102, 150, 55] {
        let event = WithdrawalRequestedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::WithdrawalRequested {
            market_id: event.market_id,
            user: event.user.to_string(),
            shares: event.shares,
            min_assets_out: event.min_assets_out,
        }));
    }
    if discriminator == [119, 175, 207, 80, 186, 237, 229, 9] {
        let event = WithdrawalCancelledEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::WithdrawalCancelled {
            market_id: event.market_id,
            user: event.user.to_string(),
            shares: event.shares,
        }));
    }
    if discriminator == [37, 78, 199, 192, 51, 68, 173, 162] {
        let event = WithdrawalExecutedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::WithdrawalExecuted {
            market_id: event.market_id,
            user: event.user.to_string(),
            shares: event.shares,
            assets: event.assets,
        }));
    }
    if discriminator == [202, 213, 134, 216, 108, 14, 84, 99] {
        let event =
            ProtocolFeesWithdrawnEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::ProtocolFeesWithdrawn {
            market_id: event.market_id,
            destination: event.destination.to_string(),
            assets: event.assets,
        }));
    }
    if discriminator == [180, 60, 123, 94, 7, 16, 234, 28] {
        let event =
            FallbackPayoutClaimedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(Some(DomainEvent::FallbackPayoutClaimed {
            user: event.user.to_string(),
            destination: event.destination.to_string(),
            assets: event.assets,
        }));
    }
    if discriminator == [102, 84, 205, 59, 243, 49, 7, 130] {
        MarketModeChangedEvent::decode(data).ok_or(FailureKind::MalformedPayload)?;
        return Ok(None);
    }
    Err(FailureKind::UnknownDiscriminator)
}

fn program_data_logs<'a>(logs: &'a [String], target_program: &str) -> Vec<(usize, &'a str)> {
    let mut stack = Vec::<&str>::new();
    let mut result = Vec::new();
    for (index, log) in logs.iter().enumerate() {
        if let Some(rest) = log.strip_prefix("Program ") {
            if let Some((program, _)) = rest.split_once(" invoke [") {
                stack.push(program);
                continue;
            }
            if rest.ends_with(" success") || rest.contains(" failed: ") {
                stack.pop();
                continue;
            }
        }
        if stack.last().copied() == Some(target_program) {
            if let Some(encoded) = log.strip_prefix("Program data: ") {
                result.push((index, encoded));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use borsh::BorshSerialize;
    use solana_pubkey::Pubkey;

    use super::*;

    fn event_bytes<T: BorshSerialize>(discriminator: [u8; 8], event: &T) -> Vec<u8> {
        let mut data = discriminator.to_vec();
        data.extend(borsh::to_vec(event).unwrap());
        data
    }

    #[test]
    fn carbon_events_normalize_into_storage_events() {
        let user = Pubkey::new_from_array([9; 32]);
        let created = event_bytes(
            [63, 226, 54, 63, 141, 22, 31, 221],
            &PositionCreatedEvent {
                market_id: 1,
                position_id: 7,
                user,
                entry_price: 100_000,
                collateral: 1_000_000,
                direction: CarbonDirection::Up,
                expires_at: 42,
            },
        );
        assert!(matches!(
            decode_event(&created),
            Ok(Some(DomainEvent::PositionCreated {
                market_id: 1,
                position_id: 7,
                collateral: 1_000_000,
                ..
            }))
        ));

        let closed = event_bytes(
            [157, 163, 227, 228, 13, 97, 138, 121],
            &PositionClosedEvent {
                market_id: 1,
                position_id: 7,
                outcome: CarbonPositionOutcome::Won,
                payout_amount: 1_900_000,
                lp_fee_amount: 80_000,
                platform_fee_amount: 20_000,
            },
        );
        assert!(matches!(
            decode_event(&closed),
            Ok(Some(DomainEvent::PositionClosed {
                outcome: PositionOutcome::Won,
                payout_amount: 1_900_000,
                ..
            }))
        ));
    }

    #[test]
    fn legacy_settlement_event_is_not_a_v2_domain_event() {
        let legacy_discriminator = [4, 41, 0, 74, 105, 43, 47, 97];
        assert!(matches!(
            decode_event(&legacy_discriminator),
            Err(FailureKind::UnknownDiscriminator)
        ));
    }

    #[test]
    fn recovery_malformed_known_event_is_dead_lettered() {
        let truncated = [63, 226, 54, 63, 141, 22, 31, 221];
        assert!(matches!(
            decode_event(&truncated),
            Err(FailureKind::MalformedPayload)
        ));
    }

    #[test]
    fn recovery_only_collects_target_program_data() {
        let target = PROGRAM_ID.to_string();
        let logs = vec![
            format!("Program {target} invoke [1]"),
            "Program Other111111111111111111111111111111111 invoke [2]".to_owned(),
            "Program data: foreign".to_owned(),
            "Program Other111111111111111111111111111111111 success".to_owned(),
            "Program data: owned".to_owned(),
            format!("Program {target} success"),
        ];
        assert_eq!(program_data_logs(&logs, &target), vec![(4, "owned")]);
    }
}
