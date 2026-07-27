CREATE SCHEMA IF NOT EXISTS indexer;

CREATE TABLE indexer.chain_sources (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('base', 'er')),
    endpoint TEXT NOT NULL,
    validator_identity TEXT,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (network, layer, endpoint)
);

CREATE TABLE indexer.sync_cursors (
    source_id BIGINT NOT NULL REFERENCES indexer.chain_sources(id),
    datasource TEXT NOT NULL,
    cursor_value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, datasource)
);

CREATE TABLE indexer.transactions (
    source_id BIGINT NOT NULL REFERENCES indexer.chain_sources(id),
    signature TEXT NOT NULL,
    slot BIGINT NOT NULL CHECK (slot >= 0),
    block_time TIMESTAMPTZ,
    succeeded BOOLEAN NOT NULL,
    event_contract_version SMALLINT NOT NULL,
    is_partial BOOLEAN NOT NULL DEFAULT false,
    raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, signature)
);

CREATE TABLE indexer.instructions (
    source_id BIGINT NOT NULL,
    signature TEXT NOT NULL,
    instruction_path TEXT NOT NULL,
    program_id TEXT NOT NULL,
    decoded_variant TEXT NOT NULL,
    discriminator BYTEA,
    normalized_payload JSONB NOT NULL,
    event_contract_version SMALLINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, signature, instruction_path, decoded_variant),
    FOREIGN KEY (source_id, signature)
        REFERENCES indexer.transactions(source_id, signature)
        ON DELETE CASCADE
);

CREATE TABLE indexer.account_observations (
    source_id BIGINT NOT NULL REFERENCES indexer.chain_sources(id),
    pubkey TEXT NOT NULL,
    slot BIGINT NOT NULL CHECK (slot >= 0),
    owner TEXT NOT NULL,
    data_hash TEXT NOT NULL,
    decoded_type TEXT,
    decoded_payload JSONB,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, pubkey, slot, data_hash)
);

CREATE TABLE indexer.markets (
    network TEXT NOT NULL,
    program_id TEXT NOT NULL,
    market_id INTEGER NOT NULL CHECK (market_id BETWEEN 0 AND 65535),
    market_pubkey TEXT,
    mode TEXT,
    total_shares NUMERIC(39, 0),
    open_collateral BIGINT,
    active_positions INTEGER,
    pool_balance BIGINT,
    last_source_id BIGINT REFERENCES indexer.chain_sources(id),
    last_slot BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (network, program_id, market_id)
);

CREATE TABLE indexer.positions (
    network TEXT NOT NULL,
    program_id TEXT NOT NULL,
    market_id INTEGER NOT NULL CHECK (market_id BETWEEN 0 AND 65535),
    position_id BIGINT NOT NULL CHECK (position_id BETWEEN 0 AND 4294967295),
    user_pubkey TEXT,
    entry_price BIGINT,
    collateral BIGINT CHECK (collateral IS NULL OR collateral BETWEEN 0 AND 4294967295),
    direction TEXT CHECK (direction IS NULL OR direction IN ('up', 'down')),
    expires_at TIMESTAMPTZ,
    lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('open', 'settled', 'refunded')),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('won', 'lost', 'breakeven', 'refunded')),
    payout_amount BIGINT CHECK (payout_amount IS NULL OR payout_amount >= 0),
    lp_fee_amount BIGINT CHECK (lp_fee_amount IS NULL OR lp_fee_amount >= 0),
    platform_fee_amount BIGINT CHECK (platform_fee_amount IS NULL OR platform_fee_amount >= 0),
    total_fee_amount BIGINT GENERATED ALWAYS AS (
        CASE
            WHEN lp_fee_amount IS NULL OR platform_fee_amount IS NULL THEN NULL
            ELSE lp_fee_amount + platform_fee_amount
        END
    ) STORED,
    net_pnl BIGINT GENERATED ALWAYS AS (
        CASE
            WHEN payout_amount IS NULL OR collateral IS NULL THEN NULL
            ELSE payout_amount - collateral
        END
    ) STORED,
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    event_contract_version SMALLINT NOT NULL,
    is_partial BOOLEAN NOT NULL DEFAULT false,
    created_source_id BIGINT REFERENCES indexer.chain_sources(id),
    created_signature TEXT,
    closed_source_id BIGINT REFERENCES indexer.chain_sources(id),
    closed_signature TEXT,
    last_slot BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (network, program_id, market_id, position_id)
);

CREATE INDEX positions_user_history
    ON indexer.positions (network, program_id, user_pubkey, closed_at DESC, market_id, position_id);

CREATE TABLE indexer.liquidity_events (
    source_id BIGINT NOT NULL,
    signature TEXT NOT NULL,
    instruction_path TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN ('deposit', 'withdrawal_requested', 'withdrawal_cancelled', 'withdrawal_executed')
    ),
    network TEXT NOT NULL,
    program_id TEXT NOT NULL,
    market_id INTEGER NOT NULL CHECK (market_id BETWEEN 0 AND 65535),
    user_pubkey TEXT NOT NULL,
    assets BIGINT,
    shares NUMERIC(39, 0) NOT NULL,
    min_assets_out BIGINT,
    occurred_at TIMESTAMPTZ,
    event_contract_version SMALLINT NOT NULL,
    PRIMARY KEY (source_id, signature, instruction_path, event_kind),
    FOREIGN KEY (source_id, signature)
        REFERENCES indexer.transactions(source_id, signature)
        ON DELETE CASCADE
);

CREATE TABLE indexer.fee_events (
    source_id BIGINT NOT NULL,
    signature TEXT NOT NULL,
    instruction_path TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('protocol_withdrawal', 'fallback_claim')),
    network TEXT NOT NULL,
    program_id TEXT NOT NULL,
    market_id INTEGER,
    user_pubkey TEXT,
    destination TEXT NOT NULL,
    assets BIGINT NOT NULL CHECK (assets >= 0),
    occurred_at TIMESTAMPTZ,
    event_contract_version SMALLINT NOT NULL,
    PRIMARY KEY (source_id, signature, instruction_path, event_kind),
    FOREIGN KEY (source_id, signature)
        REFERENCES indexer.transactions(source_id, signature)
        ON DELETE CASCADE
);

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
    outcome,
    payout_amount,
    lp_fee_amount,
    platform_fee_amount,
    total_fee_amount,
    net_pnl,
    opened_at,
    closed_at,
    event_contract_version,
    is_partial
FROM indexer.positions;
