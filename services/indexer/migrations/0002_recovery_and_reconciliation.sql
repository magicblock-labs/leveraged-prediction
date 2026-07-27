ALTER TABLE indexer.sync_cursors
    ADD COLUMN cursor_slot BIGINT CHECK (cursor_slot IS NULL OR cursor_slot >= 0),
    ADD COLUMN cursor_signature TEXT;

ALTER TABLE indexer.positions
    ADD COLUMN checkpoint_status TEXT NOT NULL DEFAULT 'er_only'
        CHECK (checkpoint_status IN ('er_only', 'base_observed', 'not_applicable')),
    ADD COLUMN base_checkpoint_source_id BIGINT REFERENCES indexer.chain_sources(id),
    ADD COLUMN base_checkpoint_slot BIGINT CHECK (
        base_checkpoint_slot IS NULL OR base_checkpoint_slot >= 0
    ),
    ADD COLUMN base_checkpoint_observed_at TIMESTAMPTZ;

CREATE TABLE indexer.tracked_accounts (
    network TEXT NOT NULL,
    program_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (
        account_type IN ('market', 'user_positions', 'user_liquidity')
    ),
    market_id INTEGER CHECK (market_id IS NULL OR market_id BETWEEN 0 AND 65535),
    user_pubkey TEXT,
    current_er_source_id BIGINT REFERENCES indexer.chain_sources(id),
    current_er_endpoint TEXT,
    route_generation BIGINT NOT NULL DEFAULT 0,
    route_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (network, program_id, pubkey)
);

CREATE TABLE indexer.route_observations (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    program_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    is_delegated BOOLEAN NOT NULL,
    er_source_id BIGINT REFERENCES indexer.chain_sources(id),
    er_endpoint TEXT,
    route_generation BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (network, program_id, pubkey, route_generation)
);

CREATE INDEX route_observations_account_time
    ON indexer.route_observations (network, program_id, pubkey, observed_at DESC);

CREATE TABLE indexer.dead_letters (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES indexer.chain_sources(id),
    signature TEXT NOT NULL,
    slot BIGINT NOT NULL CHECK (slot >= 0),
    instruction_path TEXT NOT NULL,
    failure_kind TEXT NOT NULL CHECK (
        failure_kind IN (
            'unknown_discriminator',
            'unsupported_event_version',
            'malformed_payload',
            'route_mismatch'
        )
    ),
    discriminator BYTEA,
    raw_payload BYTEA NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
    UNIQUE (source_id, signature, instruction_path, failure_kind)
);

CREATE INDEX dead_letters_unresolved
    ON indexer.dead_letters (failure_kind, last_observed_at DESC);

CREATE TABLE indexer.reconciliation_runs (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES indexer.chain_sources(id),
    datasource TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    observed_slot BIGINT CHECK (observed_slot IS NULL OR observed_slot >= 0),
    accounts_requested INTEGER NOT NULL DEFAULT 0 CHECK (accounts_requested >= 0),
    accounts_found INTEGER NOT NULL DEFAULT 0 CHECK (accounts_found >= 0),
    observations_inserted INTEGER NOT NULL DEFAULT 0 CHECK (observations_inserted >= 0),
    error TEXT
);

CREATE INDEX reconciliation_runs_source_time
    ON indexer.reconciliation_runs (source_id, started_at DESC);

DROP VIEW indexer.position_history;

CREATE VIEW indexer.position_history AS
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
FROM indexer.positions;
