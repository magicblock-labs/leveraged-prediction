use anyhow::Result;
use leveraged_prediction_storage::Source;
use serde_json::Value;
use sqlx::PgPool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Reserved persisted categories are part of the recovery schema contract.
pub enum FailureKind {
    UnknownDiscriminator,
    UnsupportedEventVersion,
    MalformedPayload,
    RouteMismatch,
}

impl FailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnknownDiscriminator => "unknown_discriminator",
            Self::UnsupportedEventVersion => "unsupported_event_version",
            Self::MalformedPayload => "malformed_payload",
            Self::RouteMismatch => "route_mismatch",
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn record(
    pool: &PgPool,
    source: &Source,
    signature: &str,
    slot: i64,
    instruction_path: &str,
    kind: FailureKind,
    payload: &[u8],
    details: Value,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO indexer.dead_letters (
            source_id, signature, slot, instruction_path, failure_kind,
            discriminator, raw_payload, details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (source_id, signature, instruction_path, failure_kind)
        DO UPDATE SET
            last_observed_at = now(),
            attempts = indexer.dead_letters.attempts + 1,
            details = EXCLUDED.details
        "#,
    )
    .bind(source.id)
    .bind(signature)
    .bind(slot)
    .bind(instruction_path)
    .bind(kind.as_str())
    .bind(payload.get(..8))
    .bind(payload)
    .bind(details)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_decoder_failures_have_stable_categories() {
        assert_eq!(
            FailureKind::UnknownDiscriminator.as_str(),
            "unknown_discriminator"
        );
        assert_eq!(
            FailureKind::UnsupportedEventVersion.as_str(),
            "unsupported_event_version"
        );
        assert_eq!(FailureKind::MalformedPayload.as_str(), "malformed_payload");
        assert_eq!(FailureKind::RouteMismatch.as_str(), "route_mismatch");
    }
}
