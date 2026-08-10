# Leveraged Prediction Indexer

This directory contains two independently deployable Rust binaries over one PostgreSQL 17 database:

- `leveraged-prediction-indexer`: router-aware confirmed ER `logsSubscribe` ingestion, startup
  exact-account reconciliation, Postgres projections, and leaderboard refresh;
- `leveraged-prediction-api`: public read-only history and leaderboard API.

Neither service signs or submits a Solana transaction. The frontend keeps direct ER websocket and
session-signed transaction paths for live gameplay.

## Position history stream

The public API exposes both the paginated position history endpoint and a public WebSocket:

```text
GET /v1/users/{wallet}/positions?market_id={market_id}&limit=100
WS  /v1/users/{wallet}/positions/stream?market_id={market_id}
```

The WebSocket sends `{"type":"snapshot","positions":[...]}` immediately after connection, then
`{"type":"upsert","position":{...}}` whenever that position changes. It never sends deletes.
Postgres emits only the position identity after the writer transaction commits; the API reads the
canonical `api.position_history` row before broadcasting it. Clients should fetch every HTTP page
on refresh, merge by `(market_id, position_id)`, and treat terminal lifecycle states as monotonic.

The API verifies its dedicated PostgreSQL notification session every 30 seconds over a private
heartbeat channel. A missing heartbeat makes readiness fail, logs the underlying listener error,
reconnects the session, and sends fresh snapshots to connected clients after recovery. Monitor
`leveraged_prediction_api_position_listener_connected` and
`leveraged_prediction_api_position_listener_reconnects_total` alongside the socket metrics.

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

- `DATABASE_URL`: PostgreSQL 17 connection used by the migration release command and both runtime
  process groups;
- `INDEXER_V2_MIN_SLOT`: first slot running the checked v2 event ABI;
- `API_CORS_ORIGINS`: comma-separated exact frontend origins;
- the base RPC, router, program ID, and Market ID.

Important bounds are listed in `deploy/env.example`. The recommended production policy is:

- indexer: one active replica per Market/source set, 10 database connections, confirmed
  `logsSubscribe`, one-second reconnect delay, 30-second route verification, and a bounded
  cursor-based catch-up only at startup/reconnect;
- API: two replicas initially, autoscaling up to 10, 20 connections per replica, 256 concurrent
  requests per replica;
- edge rate limit: 60 requests/minute/IP with a burst of 20;
- query timeout: 2 seconds;
- source/indexer readiness budget: 120 seconds;
- materialized-view and API stale budget: 120 seconds; normal refresh target: 30 seconds.

The container is portable. The selected first production shape is one Fly app with one writer
Machine and two API Machines backed by a Supabase PostgreSQL 17 project. Keep the Fly region close
to the Supabase project and configure only the exact Vercel frontend origin in CORS.

The Fly profile uses smaller initial pools than the general recommendation: five writer
connections and ten API connections per Machine. Each API Machine also holds one dedicated
PostgreSQL notification connection. Confirm the Supabase connection limit before increasing either
pool.

## Fly.io with Supabase

The checked-in `fly.toml` uses two process groups from one image:

- `writer`: exactly one active indexer Machine with a private health endpoint on port `9090`;
- `api`: public HTTP/WebSocket Machines on port `8080`, initially scaled to two.

The Fly proxy configuration limits concurrent requests but does not implement the recommended
per-IP request rate. Put a rate-limiting proxy in front of the public Fly hostname or add an
application limiter before treating this as a production internet boundary.

The release command applies SQLx migrations before either process group is updated. The same
Supabase credential is used for migrations and runtime for the initial devnet deployment. Before a
mainnet deployment, split migration, writer, and API credentials into separately deployed apps or
add process-specific database configuration so the runtime services can use the checked database
roles.

Use the Supabase direct connection string on port `5432` with `sslmode=require`. Fly Machines can
reach its IPv6 endpoint. Supabase's session-mode pooler on port `5432` is an acceptable fallback.
Do not use a transaction-mode URL on port `6543`: the public position WebSocket depends on a
session-persistent PostgreSQL `LISTEN/NOTIFY` connection.

Create and populate an untracked secret file:

```bash
cp services/indexer/deploy/fly.env.example services/indexer/deploy/fly.env
```

Set the real `DATABASE_URL`, confirmed `INDEXER_V2_MIN_SLOT`, and exact frontend origin, then create
the app and stage the secrets:

```bash
fly apps create <app-name> --org magicblock-tools
fly secrets import --stage --app <app-name> \
  < services/indexer/deploy/fly.env
```

Before the first deploy, change `primary_region` in `services/indexer/fly.toml` if `sin` is not the
closest Fly region to the Supabase project. Deploy from the repository root with Fly's automatic
high-availability replicas disabled, then keep exactly one Machine for each process group:

```bash
fly deploy . --ha=false --app <app-name> --config services/indexer/fly.toml
fly scale count writer=1 api=1 --app <app-name>
```

Verify both process groups and the public API:

```bash
fly status --app <app-name>
fly checks list --app <app-name>
curl --fail https://<app-name>.fly.dev/health/ready
```

Set the Vercel frontend's `NEXT_PUBLIC_INDEXER_API_URL` to
`https://<app-name>.fly.dev` after the API check passes.

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
3. Replay retained raw observations and run the bounded cursor catch-up into the new projections.
4. Run `recovery-fixture`, `leaderboard-fixture`, and the API contract.
5. Point one canary API at the restored database, compare representative rows, then promote.
6. Start one writer and monitor cursor, dead-letter, and projection-age metrics.

## Outage behavior

- RPC/router/WebSocket outage: the writer reconnects with a bounded cursor catch-up and readiness
  becomes stale after 120 seconds; API serves the last projection with `stale: true`.
- Writer database outage: subscription processing fails and alerts; the API remains independently
  available if its read connection works.
- API database outage: `/health/ready` returns 503 and the frontend hides only indexed history.
- API notification-listener outage: `/health/ready` returns 503 until the listener reconnects;
  existing position sockets receive a canonical resync after recovery.
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
