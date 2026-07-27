CREATE OR REPLACE FUNCTION indexer.notify_position_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, indexer
AS $$
BEGIN
    IF NEW.user_pubkey IS NOT NULL THEN
        PERFORM pg_notify(
            'leveraged_prediction_positions',
            json_build_object(
                'network', NEW.network,
                'program_id', NEW.program_id,
                'user', NEW.user_pubkey,
                'market_id', NEW.market_id,
                'position_id', NEW.position_id
            )::text
        );
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS position_change_notification ON indexer.positions;
CREATE TRIGGER position_change_notification
AFTER INSERT OR UPDATE ON indexer.positions
FOR EACH ROW
EXECUTE FUNCTION indexer.notify_position_change();

REVOKE ALL ON FUNCTION indexer.notify_position_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION indexer.notify_position_change()
    TO leveraged_prediction_writer;
