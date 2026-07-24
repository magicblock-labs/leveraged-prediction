#[cfg(test)]
use std::collections::BTreeMap;

use anyhow::Result;
use leveraged_prediction_storage::Source;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Cursor {
    pub source_id: i64,
    pub datasource: String,
    pub cursor_value: String,
    pub cursor_slot: Option<i64>,
    pub cursor_signature: Option<String>,
}

pub async fn load(pool: &PgPool, source_id: i64, datasource: &str) -> Result<Option<Cursor>> {
    Ok(sqlx::query_as::<_, Cursor>(
        r#"
        SELECT source_id, datasource, cursor_value, cursor_slot, cursor_signature
        FROM indexer.sync_cursors
        WHERE source_id = $1 AND datasource = $2
        "#,
    )
    .bind(source_id)
    .bind(datasource)
    .fetch_optional(pool)
    .await?)
}

pub async fn advance(
    tx: &mut Transaction<'_, Postgres>,
    source: &Source,
    datasource: &str,
    cursor_value: &str,
    slot: i64,
    signature: Option<&str>,
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
    .bind(source.id)
    .bind(datasource)
    .bind(cursor_value)
    .bind(slot)
    .bind(signature)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
pub struct CursorBook {
    slots: BTreeMap<(i64, String), i64>,
}

#[cfg(test)]
impl CursorBook {
    pub fn advance(&mut self, source_id: i64, datasource: &str, slot: i64) -> bool {
        let current = self
            .slots
            .entry((source_id, datasource.to_owned()))
            .or_insert(slot);
        if slot < *current {
            return false;
        }
        *current = slot;
        true
    }

    pub fn slot(&self, source_id: i64, datasource: &str) -> Option<i64> {
        self.slots.get(&(source_id, datasource.to_owned())).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_cursor_does_not_regress_on_out_of_order_delivery() {
        let mut cursors = CursorBook::default();
        assert!(cursors.advance(1, "transactions", 50));
        assert!(!cursors.advance(1, "transactions", 49));
        assert_eq!(cursors.slot(1, "transactions"), Some(50));
    }

    #[test]
    fn recovery_equal_slots_remain_source_scoped() {
        let mut cursors = CursorBook::default();
        assert!(cursors.advance(10, "transactions", 77));
        assert!(cursors.advance(11, "transactions", 77));
        assert_eq!(cursors.slot(10, "transactions"), Some(77));
        assert_eq!(cursors.slot(11, "transactions"), Some(77));
    }

    #[test]
    fn recovery_disconnect_replays_an_overlap_without_cursor_regression() {
        let mut cursors = CursorBook::default();
        assert!(cursors.advance(1, "transactions", 100));
        for slot in 96..=105 {
            let advanced = cursors.advance(1, "transactions", slot);
            assert_eq!(advanced, slot >= 100);
        }
        assert_eq!(cursors.slot(1, "transactions"), Some(105));
    }
}
