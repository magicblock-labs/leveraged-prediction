use anyhow::{bail, Context, Result};
use carbon_leveraged_prediction_decoder::PROGRAM_ID;
use leveraged_prediction_storage::Storage;
use serde::Serialize;
use solana_pubkey::Pubkey;
use url::Url;

use crate::{
    cursors,
    reconcile::exact_accounts::{self, ReconcileReport},
    sources::{
        router::RouterClient,
        supervisor::{persist_route, SourceSupervisor},
        CarbonSourceBoundary,
    },
    ProbeConfig,
};

#[derive(Debug, Serialize)]
pub struct SmokeReport {
    network: String,
    program_id: String,
    market_id: u16,
    market: String,
    route_generation: i64,
    routed_er: String,
    passes: usize,
    base_reconciliation: ReconcileReport,
    er_reconciliation: ReconcileReport,
    source_count: i64,
    market_count: i64,
    cursor_count: i64,
    duplicate_positions: i64,
    projection_matches_routed_account: bool,
}

#[derive(Debug, Serialize)]
pub struct ApiCheckReport {
    endpoint: String,
    ready: bool,
    market_id: u16,
    projection_high_water_mark: Option<i64>,
    leaderboard_rows: usize,
    stale: bool,
}

pub async fn run(
    config: ProbeConfig,
    database_url: &str,
    restart_check: bool,
) -> Result<SmokeReport> {
    let storage = Storage::connect(database_url).await?;
    storage.migrate().await?;
    run_with_storage(&config, &storage, restart_check).await
}

pub async fn run_with_storage(
    config: &ProbeConfig,
    storage: &Storage,
    restart_check: bool,
) -> Result<SmokeReport> {
    let market_id_bytes = config.market_id.to_le_bytes();
    let (market, _) =
        Pubkey::find_program_address(&[b"market", &market_id_bytes], &config.program_id);
    let router = RouterClient::new(config.router.clone());
    let route = router.resolve(&market).await?;
    if !route.is_delegated {
        bail!("Market {market} is not delegated");
    }
    let persisted = persist_route(
        &storage,
        config.network.as_str(),
        &config.program_id,
        &market,
        "market",
        Some(config.market_id),
        None,
        &route,
    )
    .await?
    .context("delegated Market did not produce a persisted ER source")?;
    let er_endpoint = route
        .endpoint
        .clone()
        .context("delegated route has no endpoint")?;
    let carbon = CarbonSourceBoundary::new(&er_endpoint, config.program_id)?;
    if !carbon.is_ready() {
        bail!("Carbon source boundary is not ready");
    }

    let mut supervisor = SourceSupervisor::default();
    supervisor.apply(market, route)?;
    if supervisor.unique_active_endpoints().len() != 1
        || supervisor.ensure_compatible_routes([&market])? != Some(er_endpoint.clone())
    {
        bail!("source supervisor produced an inconsistent Market route");
    }
    let base_source = storage
        .ensure_source(config.network.as_str(), "base", config.base_rpc.as_str())
        .await?;
    let tracked =
        exact_accounts::load_tracked(&storage, config.network.as_str(), &config.program_id).await?;
    if tracked.is_empty() {
        bail!("no tracked accounts were discovered");
    }
    for account in tracked.iter().filter(|account| account.pubkey != market) {
        let account_route = router.resolve(&account.pubkey).await?;
        persist_route(
            &storage,
            config.network.as_str(),
            &config.program_id,
            &account.pubkey,
            account.account_type.as_str(),
            account.market_id,
            account.user_pubkey.as_ref(),
            &account_route,
        )
        .await?;
        supervisor.apply(account.pubkey, account_route)?;
    }
    let tracked_pubkeys = tracked
        .iter()
        .map(|account| &account.pubkey)
        .collect::<Vec<_>>();
    if supervisor.ensure_compatible_routes(tracked_pubkeys)? != Some(er_endpoint.clone()) {
        bail!("tracked Market and user accounts are routed to different ERs");
    }
    for account in &tracked {
        supervisor.mark_caught_up(&account.pubkey, &er_endpoint)?;
    }
    let passes = if restart_check { 2 } else { 1 };
    let mut base_reconciliation = None;
    let mut er_reconciliation = None;
    for _ in 0..passes {
        base_reconciliation = Some(
            exact_accounts::reconcile(
                &storage,
                &base_source,
                config.base_rpc.as_str(),
                &config.program_id,
                &tracked,
            )
            .await?,
        );
        er_reconciliation = Some(
            exact_accounts::reconcile(
                &storage,
                &persisted.source,
                er_endpoint.as_str(),
                &config.program_id,
                &tracked,
            )
            .await?,
        );
    }

    let source_count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM indexer.chain_sources WHERE network = $1",
    )
    .bind(config.network.as_str())
    .fetch_one(storage.pool())
    .await?;
    let market_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM indexer.markets
        WHERE network = $1 AND program_id = $2 AND market_id = $3
        "#,
    )
    .bind(config.network.as_str())
    .bind(PROGRAM_ID.to_string())
    .bind(i32::from(config.market_id))
    .fetch_one(storage.pool())
    .await?;
    let cursor_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM indexer.sync_cursors
        WHERE source_id IN ($1, $2) AND datasource = 'exact_accounts'
        "#,
    )
    .bind(base_source.id)
    .bind(persisted.source.id)
    .fetch_one(storage.pool())
    .await?;
    let duplicate_positions = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM (
            SELECT network, program_id, market_id, position_id
            FROM indexer.positions
            GROUP BY network, program_id, market_id, position_id
            HAVING count(*) > 1
        ) duplicates
        "#,
    )
    .fetch_one(storage.pool())
    .await?;
    let projection_matches_routed_account = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM indexer.markets
            WHERE network = $1
              AND program_id = $2
              AND market_id = $3
              AND market_pubkey = $4
              AND last_source_id = $5
        )
        "#,
    )
    .bind(config.network.as_str())
    .bind(PROGRAM_ID.to_string())
    .bind(i32::from(config.market_id))
    .bind(market.to_string())
    .bind(persisted.source.id)
    .fetch_one(storage.pool())
    .await?;

    if restart_check
        && (market_count != 1
            || cursor_count != 2
            || duplicate_positions != 0
            || !projection_matches_routed_account)
    {
        bail!(
            "restart smoke invariant failed: markets={market_count}, cursors={cursor_count}, \
             duplicate_positions={duplicate_positions}, projection_match={projection_matches_routed_account}"
        );
    }

    let er_cursor = cursors::load(storage.pool(), persisted.source.id, "exact_accounts")
        .await?
        .context("ER reconciliation did not persist a cursor")?;
    if er_cursor.cursor_slot.is_none() {
        bail!("ER reconciliation cursor has no slot");
    }

    Ok(SmokeReport {
        network: config.network.as_str().to_owned(),
        program_id: config.program_id.to_string(),
        market_id: config.market_id,
        market: market.to_string(),
        route_generation: persisted.generation,
        routed_er: redact_endpoint(&er_endpoint),
        passes,
        base_reconciliation: base_reconciliation.context("base reconciliation did not run")?,
        er_reconciliation: er_reconciliation.context("ER reconciliation did not run")?,
        source_count,
        market_count,
        cursor_count,
        duplicate_positions,
        projection_matches_routed_account,
    })
}

fn redact_endpoint(endpoint: &Url) -> String {
    crate::sources::redact_url(endpoint)
}

pub async fn check_api(endpoint: &Url, chain: &SmokeReport) -> Result<ApiCheckReport> {
    let client = reqwest::Client::new();
    let ready_endpoint = endpoint.join("health/ready")?;
    let ready = client
        .get(ready_endpoint)
        .send()
        .await
        .context("API readiness request failed")?
        .error_for_status()
        .context("API is not ready")?
        .json::<serde_json::Value>()
        .await?;
    let market_endpoint = endpoint.join(&format!("v1/markets/{}/summary", chain.market_id()))?;
    let market = client
        .get(market_endpoint)
        .send()
        .await
        .context("API Market request failed")?
        .error_for_status()
        .context("API Market request returned an error")?
        .json::<serde_json::Value>()
        .await?;
    let leaderboard_endpoint = endpoint.join(&format!(
        "v1/leaderboards?period=all&market_id={}&limit=5",
        chain.market_id()
    ))?;
    let leaderboard = client
        .get(leaderboard_endpoint)
        .send()
        .await
        .context("API leaderboard request failed")?
        .error_for_status()
        .context("API leaderboard request returned an error")?
        .json::<serde_json::Value>()
        .await?;
    let api_market_id = market["data"]["market_id"]
        .as_u64()
        .context("API Market response has no market_id")?;
    if api_market_id != u64::from(chain.market_id()) || chain.market_count != 1 {
        bail!(
            "API/direct projection mismatch: api_market={api_market_id}, direct_market_count={}",
            chain.market_count
        );
    }
    let projection_high_water_mark = leaderboard["meta"]["projection_high_water_mark"].as_i64();
    let leaderboard_rows = leaderboard["data"]
        .as_array()
        .context("API leaderboard response data is not an array")?
        .len();
    let stale = leaderboard["meta"]["stale"]
        .as_bool()
        .context("API leaderboard response has no stale metadata")?;
    Ok(ApiCheckReport {
        endpoint: redact_endpoint(endpoint),
        ready: ready["status"] == "ready",
        market_id: chain.market_id(),
        projection_high_water_mark,
        leaderboard_rows,
        stale,
    })
}

impl SmokeReport {
    fn market_id(&self) -> u16 {
        self.market_id
    }
}
