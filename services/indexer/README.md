# Leveraged Prediction Indexer

This directory contains two independently deployable Rust binaries over one PostgreSQL 17 database:

- `leveraged-prediction-indexer`: router-aware read-only Solana/ER ingestion, exact-account
  reconciliation, Postgres projections, and leaderboard refresh;
- `leveraged-prediction-api`: public read-only history and leaderboard API.

Neither service signs or submits a Solana transaction. The frontend keeps direct ER websocket and
session-signed transaction paths for live gameplay.

## Local stack

Copy `deploy/env.example` to an untracked environment file and set a real
`INDEXER_V2_MIN_SLOT` before decoding a v2 deployment:

```bash
docker compose --env-file services/indexer/deploy/local.env \
  -f services/indexer/docker-compose.yml up --build --wait
curl --fail http://127.0.0.1:18080/health/ready
curl --fail http://127.0.0.1:19090/health/ready
```

The Compose stack runs, in order, PostgreSQL, a one-shot migration job, a one-shot role-membership
grant, one writer, and one API. The API uses a distinct login that inherits only
`leveraged_prediction_api`; the writer inherits `leveraged_prediction_writer`. Runtime processes
call `require_current_schema` and cannot silently migrate.

Local defaults are intentionally loopback-only. They are not production credentials.

## Runtime configuration

Required production values:

- `DATABASE_URL`: independent writer or API credential;
- `INDEXER_V2_MIN_SLOT`: first slot running the checked v2 event ABI;
- `API_CORS_ORIGINS`: comma-separated exact frontend origins;
- the base RPC, router, program ID, and Market ID.

Important bounds are listed in `deploy/env.example`. The recommended production policy is:

- indexer: one active replica per Market/source set, 10 database connections, 5-second loop;
- API: two replicas initially, autoscaling up to 10, 20 connections per replica, 256 concurrent
  requests per replica;
- edge rate limit: 60 requests/minute/IP with a burst of 20;
- query timeout: 2 seconds;
- source/indexer readiness budget: 120 seconds;
- materialized-view and API stale budget: 120 seconds; normal refresh target: 30 seconds.

The container is portable. The selected first production shape is two small Fly.io Machines
(one writer, two API Machines) and managed PostgreSQL 17 in the same region. Keep the API behind the
frontend reverse proxy; do not enable wildcard CORS.

## Data lifecycle and recovery

- Keep canonical positions, liquidity events, fee events, and Market snapshots indefinitely.
- Keep successful raw transaction/instruction observations for 90 days.
- Keep account observations for 30 days after their latest durable checkpoint.
- Keep dead letters until resolved, then 30 additional days.
- Run retention only after a verified daily backup.

Use managed daily backups with 30-day retention and weekly restore drills. Migrations are forward
only: take a backup before promotion, run the migration job once, and roll application containers
back if needed. A schema rollback is a reviewed forward migration; never rewrite SQLx migration
history.

Reprojection procedure:

1. Stop the writer; leave the API serving the last projection with stale metadata.
2. Restore to a new database, run migrations, and verify capability grants.
3. Replay retained raw observations and crawl overlap into the new projections.
4. Run `recovery-fixture`, `leaderboard-fixture`, and the API contract.
5. Point one canary API at the restored database, compare representative rows, then promote.
6. Start one writer and monitor cursor, dead-letter, and projection-age metrics.

## Outage behavior

- RPC/router outage: the writer remains live but readiness becomes stale after 120 seconds; API
  serves the last projection with `stale: true`.
- Writer database outage: cycles fail and alert; the API remains independently available if its
  read connection works.
- API database outage: `/health/ready` returns 503 and the frontend hides only indexed history.
- Refresh failure: the previous concurrent materialized views remain readable; refresh state retains
  the error and alerts.
- API restart: clients retry; refresh-bound cursors may return `cursor_stale` and restart from the
  newest page.

## Monitoring and ownership

Scrape `/metrics` on both services. Install `deploy/alerts.yml`. Page alerts go to the deployment
owner through the configured `ALERT_WEBHOOK`; ticket alerts go to the repository issue tracker.
Dhruv owns database/RPC/API secret rotation until an operations owner is assigned. Rotate service
credentials every 90 days and immediately after personnel or provider access changes.

Structured logs are one JSON object per line and contain no database URLs or RPC credentials.

## Release boundary

A local container pass is not a production deployment. Before production promotion:

- set the confirmed v2 activation slot;
- run the complete gate map;
- confirm backup restore evidence;
- configure the actual frontend origin, edge rate limit, metrics scraper, and alert webhook;
- obtain separate approval for any devnet program upgrade or signed transaction.
