DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leveraged_prediction_writer') THEN
        CREATE ROLE leveraged_prediction_writer NOLOGIN;
    END IF;
END
$$;

REVOKE ALL ON SCHEMA indexer FROM leveraged_prediction_writer;
REVOKE ALL ON SCHEMA api FROM leveraged_prediction_writer;
GRANT USAGE ON SCHEMA indexer, api TO leveraged_prediction_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA indexer
    TO leveraged_prediction_writer;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA indexer
    TO leveraged_prediction_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA api TO leveraged_prediction_writer;
GRANT MAINTAIN ON TABLE api.leaderboard_market, api.leaderboard_global
    TO leveraged_prediction_writer;
GRANT SELECT ON TABLE public._sqlx_migrations TO leveraged_prediction_writer;

REVOKE ALL ON ALL TABLES IN SCHEMA indexer FROM leveraged_prediction_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA indexer FROM leveraged_prediction_api;
GRANT USAGE ON SCHEMA api TO leveraged_prediction_api;
GRANT SELECT ON
    api.leaderboard_market,
    api.leaderboard_global,
    api.position_history,
    api.liquidity_history,
    api.market_summary,
    api.projection_status
TO leveraged_prediction_api;
GRANT SELECT ON TABLE public._sqlx_migrations TO leveraged_prediction_api;

ALTER DEFAULT PRIVILEGES IN SCHEMA indexer
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leveraged_prediction_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA indexer
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO leveraged_prediction_writer;
