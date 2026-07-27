use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Period {
    Today,
    Week,
    Month,
    All,
}

impl Period {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Week => "week",
            Self::Month => "month",
            Self::All => "all",
        }
    }
}

impl fmt::Display for Period {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Period {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "today" => Ok(Self::Today),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            "all" => Ok(Self::All),
            _ => Err("period must be today, week, month, or all"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PositionStatus {
    Open,
    Closed,
    Refunded,
}

impl PositionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Refunded => "refunded",
        }
    }
}

impl FromStr for PositionStatus {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "open" => Ok(Self::Open),
            "closed" => Ok(Self::Closed),
            "refunded" => Ok(Self::Refunded),
            _ => Err("status must be open, closed, or refunded"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Envelope<T> {
    pub data: T,
    pub meta: ResponseMeta,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResponseMeta {
    pub as_of: DateTime<Utc>,
    pub projection_high_water_mark: Option<i64>,
    pub refresh_version: i64,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LeaderboardEntry {
    pub rank: i64,
    pub user: String,
    pub trades: i64,
    pub wins: i64,
    pub losses: i64,
    pub breakevens: i64,
    pub refunds: i64,
    pub volume: String,
    pub payout: String,
    pub net_pnl: String,
    pub lp_fees: String,
    pub platform_fees: String,
    pub total_fees: String,
    pub win_rate_bps: i32,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct PositionItem {
    pub market_id: i32,
    pub position_id: i64,
    pub user: Option<String>,
    pub direction: Option<String>,
    pub entry_price: Option<String>,
    pub collateral: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub lifecycle_status: String,
    pub checkpoint_status: String,
    pub outcome: Option<String>,
    pub payout_amount: Option<String>,
    pub lp_fee_amount: Option<String>,
    pub platform_fee_amount: Option<String>,
    pub total_fee_amount: Option<String>,
    pub net_pnl: Option<String>,
    pub opened_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    #[serde(skip)]
    pub sort_time: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LiquidityItem {
    pub signature: String,
    pub instruction_path: String,
    pub event_kind: String,
    pub market_id: i32,
    pub user: String,
    pub assets: Option<String>,
    pub shares: String,
    pub min_assets_out: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
    #[serde(skip)]
    pub sort_time: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MarketSummary {
    pub market_id: i32,
    pub market_pubkey: Option<String>,
    pub mode: Option<String>,
    pub total_shares: Option<String>,
    pub open_collateral: Option<String>,
    pub active_positions: Option<i32>,
    pub pool_balance: Option<String>,
    pub last_slot: Option<i64>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UserStats {
    pub user: String,
    pub period: Period,
    pub market_id: Option<u16>,
    pub trades: i64,
    pub wins: i64,
    pub losses: i64,
    pub breakevens: i64,
    pub refunds: i64,
    pub volume: String,
    pub payout: String,
    pub net_pnl: String,
    pub lp_fees: String,
    pub platform_fees: String,
    pub total_fees: String,
    pub win_rate_bps: i32,
    pub rank: Option<i64>,
}

impl UserStats {
    pub fn empty(user: String, period: Period, market_id: Option<u16>) -> Self {
        Self {
            user,
            period,
            market_id,
            trades: 0,
            wins: 0,
            losses: 0,
            breakevens: 0,
            refunds: 0,
            volume: "0".to_owned(),
            payout: "0".to_owned(),
            net_pnl: "0".to_owned(),
            lp_fees: "0".to_owned(),
            platform_fees: "0".to_owned(),
            total_fees: "0".to_owned(),
            win_rate_bps: 0,
            rank: None,
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ProjectionStatus {
    pub refresh_version: i64,
    pub last_success_at: Option<DateTime<Utc>>,
    pub source_high_water_mark: Option<i64>,
    pub last_error: Option<String>,
}
