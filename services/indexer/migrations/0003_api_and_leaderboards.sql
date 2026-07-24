CREATE SCHEMA api;

CREATE TABLE indexer.projection_refresh_state (
    projection_name TEXT PRIMARY KEY,
    refresh_version BIGINT NOT NULL DEFAULT 0 CHECK (refresh_version >= 0),
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_duration_ms BIGINT CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
    source_high_water_mark BIGINT CHECK (
        source_high_water_mark IS NULL OR source_high_water_mark >= 0
    ),
    utc_day DATE,
    utc_week DATE,
    utc_month DATE,
    last_error TEXT
);

INSERT INTO indexer.projection_refresh_state (projection_name)
VALUES ('leaderboards');

CREATE MATERIALIZED VIEW api.leaderboard_market AS
WITH periods(period, period_start, period_end) AS (
    VALUES
        (
            'today'::TEXT,
            date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (date_trunc('day', now() AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC'
        ),
        (
            'week'::TEXT,
            date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (date_trunc('week', now() AT TIME ZONE 'UTC') + INTERVAL '1 week') AT TIME ZONE 'UTC'
        ),
        (
            'month'::TEXT,
            date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (date_trunc('month', now() AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC'
        ),
        ('all'::TEXT, '-infinity'::TIMESTAMPTZ, NULL::TIMESTAMPTZ)
),
aggregated AS (
    SELECT
        p.network,
        p.program_id,
        p.market_id,
        periods.period,
        periods.period_start,
        periods.period_end,
        p.user_pubkey,
        count(*) FILTER (WHERE p.outcome <> 'refunded')::BIGINT AS trades,
        count(*) FILTER (WHERE p.outcome = 'won')::BIGINT AS wins,
        count(*) FILTER (WHERE p.outcome = 'lost')::BIGINT AS losses,
        count(*) FILTER (WHERE p.outcome = 'breakeven')::BIGINT AS breakevens,
        count(*) FILTER (WHERE p.outcome = 'refunded')::BIGINT AS refunds,
        COALESCE(sum(p.collateral) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS volume,
        COALESCE(sum(p.payout_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS payout,
        COALESCE(sum(p.net_pnl) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS net_pnl,
        COALESCE(sum(p.lp_fee_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS lp_fees,
        COALESCE(sum(p.platform_fee_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS platform_fees,
        COALESCE(sum(p.total_fee_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS total_fees,
        CASE
            WHEN count(*) FILTER (WHERE p.outcome IN ('won', 'lost')) = 0 THEN 0
            ELSE (
                count(*) FILTER (WHERE p.outcome = 'won') * 10000
                / count(*) FILTER (WHERE p.outcome IN ('won', 'lost'))
            )
        END::INTEGER AS win_rate_bps,
        max(p.last_slot)::BIGINT AS projection_high_water_mark
    FROM indexer.positions p
    CROSS JOIN periods
    WHERE p.user_pubkey IS NOT NULL
      AND p.lifecycle_status IN ('settled', 'refunded')
      AND p.closed_at IS NOT NULL
      AND p.closed_at >= periods.period_start
      AND (periods.period_end IS NULL OR p.closed_at < periods.period_end)
    GROUP BY
        p.network,
        p.program_id,
        p.market_id,
        periods.period,
        periods.period_start,
        periods.period_end,
        p.user_pubkey
)
SELECT
    aggregated.*,
    row_number() OVER (
        PARTITION BY network, program_id, market_id, period
        ORDER BY net_pnl DESC, volume DESC, user_pubkey ASC
    )::BIGINT AS rank
FROM aggregated;

CREATE UNIQUE INDEX leaderboard_market_identity
    ON api.leaderboard_market (network, program_id, market_id, period, user_pubkey);

CREATE INDEX leaderboard_market_rank
    ON api.leaderboard_market (network, program_id, market_id, period, rank);

CREATE MATERIALIZED VIEW api.leaderboard_global AS
WITH periods(period, period_start, period_end) AS (
    VALUES
        (
            'today'::TEXT,
            date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (date_trunc('day', now() AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC'
        ),
        (
            'week'::TEXT,
            date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (date_trunc('week', now() AT TIME ZONE 'UTC') + INTERVAL '1 week') AT TIME ZONE 'UTC'
        ),
        (
            'month'::TEXT,
            date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (date_trunc('month', now() AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC'
        ),
        ('all'::TEXT, '-infinity'::TIMESTAMPTZ, NULL::TIMESTAMPTZ)
),
aggregated AS (
    SELECT
        p.network,
        p.program_id,
        periods.period,
        periods.period_start,
        periods.period_end,
        p.user_pubkey,
        count(*) FILTER (WHERE p.outcome <> 'refunded')::BIGINT AS trades,
        count(*) FILTER (WHERE p.outcome = 'won')::BIGINT AS wins,
        count(*) FILTER (WHERE p.outcome = 'lost')::BIGINT AS losses,
        count(*) FILTER (WHERE p.outcome = 'breakeven')::BIGINT AS breakevens,
        count(*) FILTER (WHERE p.outcome = 'refunded')::BIGINT AS refunds,
        COALESCE(sum(p.collateral) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS volume,
        COALESCE(sum(p.payout_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS payout,
        COALESCE(sum(p.net_pnl) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS net_pnl,
        COALESCE(sum(p.lp_fee_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS lp_fees,
        COALESCE(sum(p.platform_fee_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS platform_fees,
        COALESCE(sum(p.total_fee_amount) FILTER (WHERE p.outcome <> 'refunded'), 0)::NUMERIC(39, 0)
            AS total_fees,
        CASE
            WHEN count(*) FILTER (WHERE p.outcome IN ('won', 'lost')) = 0 THEN 0
            ELSE (
                count(*) FILTER (WHERE p.outcome = 'won') * 10000
                / count(*) FILTER (WHERE p.outcome IN ('won', 'lost'))
            )
        END::INTEGER AS win_rate_bps,
        max(p.last_slot)::BIGINT AS projection_high_water_mark
    FROM indexer.positions p
    CROSS JOIN periods
    WHERE p.user_pubkey IS NOT NULL
      AND p.lifecycle_status IN ('settled', 'refunded')
      AND p.closed_at IS NOT NULL
      AND p.closed_at >= periods.period_start
      AND (periods.period_end IS NULL OR p.closed_at < periods.period_end)
    GROUP BY
        p.network,
        p.program_id,
        periods.period,
        periods.period_start,
        periods.period_end,
        p.user_pubkey
)
SELECT
    aggregated.*,
    row_number() OVER (
        PARTITION BY network, program_id, period
        ORDER BY net_pnl DESC, volume DESC, user_pubkey ASC
    )::BIGINT AS rank
FROM aggregated;

CREATE UNIQUE INDEX leaderboard_global_identity
    ON api.leaderboard_global (network, program_id, period, user_pubkey);

CREATE INDEX leaderboard_global_rank
    ON api.leaderboard_global (network, program_id, period, rank);

CREATE VIEW api.position_history AS
SELECT
    network,
    program_id,
    market_id,
    position_id,
    user_pubkey,
    entry_price,
    collateral,
    direction,
    expires_at,
    lifecycle_status,
    checkpoint_status,
    outcome,
    payout_amount,
    lp_fee_amount,
    platform_fee_amount,
    total_fee_amount,
    net_pnl,
    opened_at,
    closed_at,
    base_checkpoint_slot,
    base_checkpoint_observed_at,
    event_contract_version,
    is_partial
FROM indexer.position_history;

CREATE VIEW api.liquidity_history AS
SELECT
    source_id,
    signature,
    instruction_path,
    event_kind,
    network,
    program_id,
    market_id,
    user_pubkey,
    assets,
    shares,
    min_assets_out,
    occurred_at
FROM indexer.liquidity_events;

CREATE VIEW api.market_summary AS
SELECT
    network,
    program_id,
    market_id,
    market_pubkey,
    mode,
    total_shares,
    open_collateral,
    active_positions,
    pool_balance,
    last_slot,
    updated_at
FROM indexer.markets;

CREATE VIEW api.projection_status AS
SELECT
    projection_name,
    refresh_version,
    last_success_at,
    last_duration_ms,
    source_high_water_mark,
    utc_day,
    utc_week,
    utc_month,
    last_error
FROM indexer.projection_refresh_state;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leveraged_prediction_api') THEN
        CREATE ROLE leveraged_prediction_api NOLOGIN;
    END IF;
END
$$;

REVOKE ALL ON SCHEMA indexer FROM leveraged_prediction_api;
REVOKE ALL ON ALL TABLES IN SCHEMA indexer FROM leveraged_prediction_api;
GRANT USAGE ON SCHEMA api TO leveraged_prediction_api;
GRANT SELECT ON
    api.leaderboard_market,
    api.leaderboard_global,
    api.position_history,
    api.liquidity_history,
    api.market_summary,
    api.projection_status
TO leveraged_prediction_api;
