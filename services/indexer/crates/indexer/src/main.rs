use std::{env, net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{bail, Context, Result};
use carbon_core::datasource::Datasource;
use carbon_leveraged_prediction_decoder::PROGRAM_ID;
use carbon_rpc_program_subscribe_datasource::{
    Filters as ProgramSubscribeFilters, RpcProgramSubscribe,
};
use carbon_rpc_transaction_crawler_datasource::{
    ConnectionConfig as CrawlerConnectionConfig, Filters as CrawlerFilters, RetryConfig,
    RpcTransactionCrawler,
};
use clap::{Parser, Subcommand, ValueEnum};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use solana_client::{
    nonblocking::{pubsub_client::PubsubClient, rpc_client::RpcClient},
    rpc_client::GetConfirmedSignaturesForAddress2Config,
    rpc_config::{RpcTransactionConfig, RpcTransactionLogsConfig, RpcTransactionLogsFilter},
};
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_transaction_status::UiTransactionEncoding;
use url::Url;

mod cursors;
mod fixture;
mod ingest;
mod leaderboard_fixture;
mod projections;
mod reconcile;
mod recovery;
mod runtime;
mod smoke;
mod sources;

const DEFAULT_BASE_RPC: &str = "https://rpc.magicblock.app/devnet";
const DEFAULT_ROUTER: &str = "https://devnet-router.magicblock.app/";
const DEFAULT_MARKET_ID: u16 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Parser)]
#[command(
    name = "leveraged-prediction-indexer",
    about = "Read-only Carbon indexer utilities for leveraged-prediction"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run routed ER logsSubscribe ingestion with startup recovery and leaderboard refresh.
    Run {
        #[arg(long, value_enum, default_value_t = Network::Devnet)]
        network: Network,
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        #[arg(long, env = "INDEXER_V2_MIN_SLOT")]
        v2_min_slot: u64,
        #[arg(long, env = "INDEXER_HEALTH_BIND", default_value = "0.0.0.0:9090")]
        bind: SocketAddr,
        #[arg(long, env = "INDEXER_RECONNECT_SECONDS", default_value_t = 1)]
        reconnect_seconds: u64,
        #[arg(long, env = "INDEXER_ROUTE_REFRESH_SECONDS", default_value_t = 30)]
        route_refresh_seconds: u64,
        #[arg(long, env = "LEADERBOARD_REFRESH_SECONDS", default_value_t = 30)]
        refresh_seconds: u64,
        #[arg(long, env = "INDEXER_MAX_STALENESS_SECONDS", default_value_t = 120)]
        maximum_staleness_seconds: u64,
        #[arg(long, env = "INDEXER_CATCHUP_LIMIT", default_value_t = 1_000)]
        catchup_limit: usize,
        #[arg(long, env = "INDEXER_DATABASE_POOL_SIZE", default_value_t = 10)]
        database_pool_size: u32,
        #[arg(long)]
        once: bool,
    },
    /// Verify base, router, and ER read capabilities without submitting transactions.
    Probe {
        #[arg(long, value_enum, default_value_t = Network::Devnet)]
        network: Network,
    },
    /// Apply all checked Postgres migrations.
    Migrate {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
    },
    /// Replay a deterministic lifecycle twice and verify idempotent projections.
    ReplayFixture {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
    },
    /// Retain known pre-v2 signatures without fabricating unavailable event fields.
    RecordLegacyFixtures {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
    },
    /// Crawl recent program transactions, decode event logs, and project them.
    IngestRecent {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        #[arg(long)]
        rpc_endpoint: String,
        #[arg(long, default_value = "devnet")]
        network: String,
        #[arg(long, default_value = "er")]
        layer: String,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        /// First slot known to run event contract v2; older same-name events have different layouts.
        #[arg(long)]
        v2_min_slot: u64,
    },
    /// Reconcile the configured Market through base and routed ER reads.
    Smoke {
        #[arg(long, value_enum, default_value_t = Network::Devnet)]
        network: Network,
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        #[arg(long)]
        restart_check: bool,
        #[arg(long)]
        api_check: bool,
        #[arg(
            long,
            env = "INDEXER_API_ENDPOINT",
            default_value = "http://127.0.0.1:18080"
        )]
        api_endpoint: Url,
    },
    /// Exercise database rollback, duplicate, ordering, and restart invariants.
    RecoveryFixture {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
    },
    /// Concurrently refresh leaderboard materialized views under an advisory lock.
    RefreshLeaderboards {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        #[arg(long)]
        force: bool,
        #[arg(long, default_value_t = 30)]
        minimum_interval_seconds: u64,
    },
    /// Seed deterministic outcome/period fixtures and verify leaderboard projections.
    LeaderboardFixture {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum Network {
    Devnet,
}

impl Network {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Devnet => "devnet",
        }
    }
}

#[derive(Debug)]
struct ProbeConfig {
    network: Network,
    base_rpc: Url,
    router: Url,
    program_id: Pubkey,
    market_id: u16,
}

impl ProbeConfig {
    fn from_env(network: Network) -> Result<Self> {
        let base_rpc = parse_http_url(
            &env::var("SOLANA_RPC_ENDPOINT").unwrap_or_else(|_| DEFAULT_BASE_RPC.to_owned()),
            "SOLANA_RPC_ENDPOINT",
        )?;
        let router = parse_http_url(
            &env::var("ROUTER_ENDPOINT").unwrap_or_else(|_| DEFAULT_ROUTER.to_owned()),
            "ROUTER_ENDPOINT",
        )?;
        let program_id = match env::var("LEVERAGED_PREDICTION_PROGRAM_ID") {
            Ok(value) => Pubkey::from_str(&value)
                .context("LEVERAGED_PREDICTION_PROGRAM_ID is not a valid pubkey")?,
            Err(_) => PROGRAM_ID,
        };
        let market_id =
            env::var("LEVERAGED_PREDICTION_MARKET_ID").map_or(Ok(DEFAULT_MARKET_ID), |value| {
                value
                    .parse::<u16>()
                    .context("LEVERAGED_PREDICTION_MARKET_ID must be a u16")
            })?;

        if program_id != PROGRAM_ID {
            bail!(
                "configured program ID {program_id} does not match decoder program ID {PROGRAM_ID}"
            );
        }

        Ok(Self {
            network,
            base_rpc,
            router,
            program_id,
            market_id,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegationStatus {
    is_delegated: bool,
    fqdn: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RouterResponse {
    result: Option<DelegationStatus>,
    error: Option<RouterError>,
}

#[derive(Debug, Deserialize)]
struct RouterError {
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProbeReport {
    network: Network,
    program_id: String,
    market_id: u16,
    market_pda: String,
    carbon: CarbonVersions,
    base: BaseReport,
    router: RouterReport,
    er: ErReport,
}

#[derive(Debug, Serialize)]
struct CarbonVersions {
    core: &'static str,
    program_subscribe: &'static str,
    transaction_crawler: &'static str,
}

#[derive(Debug, Serialize)]
struct BaseReport {
    endpoint: String,
    reachable: bool,
    market_account_found: bool,
    market_owner: Option<String>,
}

#[derive(Debug, Serialize)]
struct RouterReport {
    endpoint: String,
    delegated: bool,
    er_endpoint: String,
}

#[derive(Debug, Serialize)]
struct ErReport {
    http_endpoint: String,
    ws_endpoint: String,
    carbon_program_subscribe_boundary: bool,
    carbon_transaction_crawler_boundary: bool,
    logs_subscribe_handshake: bool,
    history_signature: String,
    transaction_fetch: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Run {
            network,
            database_url,
            v2_min_slot,
            bind,
            reconnect_seconds,
            route_refresh_seconds,
            refresh_seconds,
            maximum_staleness_seconds,
            catchup_limit,
            database_pool_size,
            once,
        } => {
            runtime::run(
                ProbeConfig::from_env(network)?,
                &database_url,
                runtime::RuntimeConfig {
                    bind,
                    reconnect_delay: Duration::from_secs(reconnect_seconds),
                    route_refresh_interval: Duration::from_secs(route_refresh_seconds),
                    refresh_interval: Duration::from_secs(refresh_seconds),
                    maximum_staleness: Duration::from_secs(maximum_staleness_seconds),
                    catchup_limit,
                    v2_min_slot,
                    database_pool_size,
                    once,
                },
            )
            .await?;
        }
        Command::Probe { network } => {
            let report = probe(ProbeConfig::from_env(network)?).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::Migrate { database_url } => {
            let storage = leveraged_prediction_storage::Storage::connect(&database_url).await?;
            storage.migrate().await?;
            println!("indexer migrations applied");
        }
        Command::ReplayFixture { database_url } => {
            let report = fixture::replay(&database_url).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::RecordLegacyFixtures { database_url } => {
            let report = fixture::record_legacy(&database_url).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::IngestRecent {
            database_url,
            rpc_endpoint,
            network,
            layer,
            limit,
            v2_min_slot,
        } => {
            let report = ingest::recent(
                &database_url,
                &network,
                &layer,
                &rpc_endpoint,
                limit,
                v2_min_slot,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::Smoke {
            network,
            database_url,
            restart_check,
            api_check,
            api_endpoint,
        } => {
            let report = smoke::run(
                ProbeConfig::from_env(network)?,
                &database_url,
                restart_check,
            )
            .await?;
            let api = if api_check {
                Some(smoke::check_api(&api_endpoint, &report).await?)
            } else {
                None
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "chain": report,
                    "api": api,
                }))?
            );
        }
        Command::RecoveryFixture { database_url } => {
            let report = recovery::verify(&database_url).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::RefreshLeaderboards {
            database_url,
            force,
            minimum_interval_seconds,
        } => {
            let report = projections::leaderboards::refresh(
                &database_url,
                force,
                Duration::from_secs(minimum_interval_seconds),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::LeaderboardFixture { database_url } => {
            let report = leaderboard_fixture::run(&database_url).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
    }
    Ok(())
}

async fn probe(config: ProbeConfig) -> Result<ProbeReport> {
    let market_id_bytes = config.market_id.to_le_bytes();
    let (market_pda, _) =
        Pubkey::find_program_address(&[b"market", &market_id_bytes], &config.program_id);

    let base_client = RpcClient::new_with_commitment(
        config.base_rpc.as_str().to_owned(),
        CommitmentConfig::confirmed(),
    );
    tokio::time::timeout(PROBE_TIMEOUT, base_client.get_version())
        .await
        .context("base RPC version probe timed out")?
        .context("base RPC version probe failed")?;
    let base_market = tokio::time::timeout(PROBE_TIMEOUT, base_client.get_account(&market_pda))
        .await
        .context("base Market account probe timed out")?
        .ok();

    let route = resolve_route(&config.router, &market_pda).await?;
    if !route.is_delegated {
        bail!("Market {market_pda} is not delegated according to the router");
    }
    let fqdn = route
        .fqdn
        .context("router reports a delegated Market without an ER fqdn")?;
    let er_http = normalize_er_endpoint(&fqdn)?;
    let er_ws = websocket_url(&er_http)?;

    let carbon_subscription = RpcProgramSubscribe::new(
        er_ws.as_str().to_owned(),
        ProgramSubscribeFilters::new(config.program_id, None),
    );
    let carbon_program_subscribe_boundary = !carbon_subscription.update_types().is_empty();

    let carbon_crawler = RpcTransactionCrawler::new(
        er_http.as_str().to_owned(),
        config.program_id,
        CrawlerConnectionConfig::new(
            1,
            Duration::from_secs(5),
            1,
            RetryConfig::no_retry(),
            Some(4),
            Some(4),
            false,
        ),
        CrawlerFilters::new(None, None, None),
        Some(CommitmentConfig::confirmed()),
    );
    let carbon_transaction_crawler_boundary = !carbon_crawler.update_types().is_empty();

    verify_logs_subscription(&er_ws, &config.program_id).await?;
    let (history_signature, transaction_fetch) =
        verify_transaction_history(&er_http, &config.program_id).await?;

    Ok(ProbeReport {
        network: config.network,
        program_id: config.program_id.to_string(),
        market_id: config.market_id,
        market_pda: market_pda.to_string(),
        carbon: CarbonVersions {
            core: "0.12.0",
            program_subscribe: "0.12.0",
            transaction_crawler: "0.12.0",
        },
        base: BaseReport {
            endpoint: redact_url(&config.base_rpc),
            reachable: true,
            market_account_found: base_market.is_some(),
            market_owner: base_market.map(|account| account.owner.to_string()),
        },
        router: RouterReport {
            endpoint: redact_url(&config.router),
            delegated: true,
            er_endpoint: redact_url(&er_http),
        },
        er: ErReport {
            http_endpoint: redact_url(&er_http),
            ws_endpoint: redact_url(&er_ws),
            carbon_program_subscribe_boundary,
            carbon_transaction_crawler_boundary,
            logs_subscribe_handshake: true,
            history_signature,
            transaction_fetch,
        },
    })
}

async fn resolve_route(router: &Url, account: &Pubkey) -> Result<DelegationStatus> {
    let endpoint = router
        .join("getDelegationStatus")
        .context("failed to construct router delegation endpoint")?;
    let response = tokio::time::timeout(
        PROBE_TIMEOUT,
        Client::new()
            .post(endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": format!("indexer-probe-{account}"),
                "method": "getDelegationStatus",
                "params": [account.to_string()],
            }))
            .send(),
    )
    .await
    .context("router probe timed out")?
    .context("router request failed")?
    .error_for_status()
    .context("router returned an HTTP error")?
    .json::<RouterResponse>()
    .await
    .context("router returned invalid JSON")?;

    if let Some(error) = response.error {
        bail!(
            "router returned an RPC error: {}",
            error.message.unwrap_or_else(|| "unknown error".to_owned())
        );
    }
    response.result.context("router response had no result")
}

async fn verify_logs_subscription(ws_endpoint: &Url, program_id: &Pubkey) -> Result<()> {
    let client = tokio::time::timeout(PROBE_TIMEOUT, PubsubClient::new(ws_endpoint.as_str()))
        .await
        .context("ER websocket connection timed out")?
        .context("ER websocket connection failed")?;
    let (stream, unsubscribe) = tokio::time::timeout(
        PROBE_TIMEOUT,
        client.logs_subscribe(
            RpcTransactionLogsFilter::Mentions(vec![program_id.to_string()]),
            RpcTransactionLogsConfig {
                commitment: Some(CommitmentConfig::confirmed()),
            },
        ),
    )
    .await
    .context("ER logsSubscribe handshake timed out")?
    .context("ER logsSubscribe handshake failed")?;
    drop(stream);
    unsubscribe().await;
    Ok(())
}

async fn verify_transaction_history(endpoint: &Url, program_id: &Pubkey) -> Result<(String, bool)> {
    let client =
        RpcClient::new_with_commitment(endpoint.as_str().to_owned(), CommitmentConfig::confirmed());
    let signatures = tokio::time::timeout(
        PROBE_TIMEOUT,
        client.get_signatures_for_address_with_config(
            program_id,
            GetConfirmedSignaturesForAddress2Config {
                before: None,
                until: None,
                limit: Some(1),
                commitment: Some(CommitmentConfig::confirmed()),
            },
        ),
    )
    .await
    .context("ER getSignaturesForAddress timed out")?
    .context("ER getSignaturesForAddress failed")?;
    let signature = signatures
        .first()
        .context("ER returned no transaction history for the program")?
        .signature
        .parse()
        .context("ER returned an invalid transaction signature")?;
    tokio::time::timeout(
        PROBE_TIMEOUT,
        client.get_transaction_with_config(
            &signature,
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Base64),
                commitment: Some(CommitmentConfig::confirmed()),
                max_supported_transaction_version: Some(0),
            },
        ),
    )
    .await
    .context("ER getTransaction timed out")?
    .context("ER getTransaction failed")?;

    Ok((signature.to_string(), true))
}

fn parse_http_url(value: &str, variable: &str) -> Result<Url> {
    let url = Url::parse(value).with_context(|| format!("{variable} is not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("{variable} must use http or https");
    }
    Ok(url)
}

fn normalize_er_endpoint(fqdn: &str) -> Result<Url> {
    let value = if fqdn.starts_with("http://") || fqdn.starts_with("https://") {
        fqdn.to_owned()
    } else {
        format!("https://{fqdn}")
    };
    parse_http_url(&value, "router ER fqdn")
}

fn websocket_url(http: &Url) -> Result<Url> {
    let mut ws = http.clone();
    let scheme = match http.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => bail!("ER endpoint must use http or https"),
    };
    ws.set_scheme(scheme)
        .map_err(|()| anyhow::anyhow!("failed to convert ER endpoint to websocket URL"))?;
    Ok(ws)
}

fn redact_url(value: &Url) -> String {
    let mut redacted = value.clone();
    let _ = redacted.set_username("");
    let _ = redacted.set_password(None);
    redacted.set_query(None);
    redacted.set_fragment(None);
    redacted.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_expected_market_pda() {
        let market_id = 1_u16.to_le_bytes();
        let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &PROGRAM_ID);
        assert_eq!(
            market.to_string(),
            "6ME7jFHJkk27zAM7hz2A3V1Y4EeTkcjyZxnekQLtn8V1"
        );
    }

    #[test]
    fn normalizes_router_fqdn_and_websocket_scheme() {
        let er = normalize_er_endpoint("asia.magicblock.app").unwrap();
        assert_eq!(er.as_str(), "https://asia.magicblock.app/");
        assert_eq!(
            websocket_url(&er).unwrap().as_str(),
            "wss://asia.magicblock.app/"
        );
    }

    #[test]
    fn redacts_rpc_credentials_and_query() {
        let url = Url::parse("https://user:secret@example.com/rpc?api-key=secret").unwrap();
        assert_eq!(redact_url(&url), "https://example.com/rpc");
    }
}
