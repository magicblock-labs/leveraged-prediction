use std::{env, net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{Context, Result};
use clap::Parser;
use leveraged_prediction_api::{
    contract_test, listen_for_position_changes, openapi, router, ApiState,
};
use leveraged_prediction_storage::Storage;
use solana_pubkey::Pubkey;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};

const DEFAULT_PROGRAM_ID: &str = "AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr";

#[derive(Debug, Parser)]
#[command(name = "leveraged-prediction-api")]
struct Cli {
    #[arg(long)]
    check_openapi: bool,
    #[arg(long)]
    print_openapi: bool,
    #[arg(long)]
    write_openapi: bool,
    #[arg(long)]
    contract_test: bool,
    #[arg(long, env = "DATABASE_URL")]
    database_url: Option<String>,
    #[arg(long, env = "API_BIND_ADDR", default_value = "127.0.0.1:8080")]
    bind: SocketAddr,
    #[arg(long, env = "INDEXER_NETWORK", default_value = "devnet")]
    network: String,
    #[arg(
        long,
        env = "LEVERAGED_PREDICTION_PROGRAM_ID",
        default_value = DEFAULT_PROGRAM_ID
    )]
    program_id: String,
    #[arg(long, env = "API_QUERY_TIMEOUT_MS", default_value_t = 2_000)]
    query_timeout_ms: u64,
    #[arg(long, env = "API_MAX_STALENESS_SECONDS", default_value_t = 120)]
    max_staleness_seconds: u64,
    #[arg(long, env = "API_DATABASE_POOL_SIZE", default_value_t = 20)]
    database_pool_size: u32,
    #[arg(long, env = "API_MAX_CONCURRENT_REQUESTS", default_value_t = 256)]
    max_concurrent_requests: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.check_openapi {
        openapi::check_snapshot()?;
        println!("OpenAPI snapshot is current");
        return Ok(());
    }
    if cli.print_openapi {
        print!("{}", openapi::pretty_document()?);
        return Ok(());
    }
    if cli.write_openapi {
        println!("wrote {}", openapi::write_snapshot()?.display());
        return Ok(());
    }
    Pubkey::from_str(&cli.program_id).context("program ID is not a valid Solana public key")?;
    let database_url = cli
        .database_url
        .context("DATABASE_URL is required to run the API")?;
    let storage =
        Storage::connect_with_max_connections(&database_url, cli.database_pool_size).await?;
    storage.require_current_schema().await?;
    let state = ApiState::new(
        storage,
        cli.network,
        cli.program_id,
        Duration::from_millis(cli.query_timeout_ms),
        Duration::from_secs(cli.max_staleness_seconds),
    );
    if cli.contract_test {
        let report = contract_test(state).await?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(cli.bind)
        .await
        .with_context(|| format!("failed to bind API listener {}", cli.bind))?;
    let local_addr = listener.local_addr()?;
    println!(
        "{}",
        serde_json::json!({
            "timestamp": chrono::Utc::now(),
            "level": "info",
            "service": "leveraged-prediction-api",
            "event": "api_started",
            "bind": local_addr,
        })
    );
    let position_listener = tokio::spawn(listen_for_position_changes(database_url, state.clone()));
    let app = router(state)
        .layer(ConcurrencyLimitLayer::new(cli.max_concurrent_requests))
        .layer(cors_layer()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    position_listener.abort();
    Ok(())
}

fn cors_layer() -> Result<CorsLayer> {
    let configured =
        env::var("API_CORS_ORIGINS").unwrap_or_else(|_| "http://localhost:3000".to_owned());
    let origins = configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse()
                .context("API_CORS_ORIGINS contains an invalid origin")
        })
        .collect::<Result<Vec<_>>>()?;
    anyhow::ensure!(!origins.is_empty(), "API_CORS_ORIGINS must not be empty");
    Ok(CorsLayer::new()
        .allow_methods([axum::http::Method::GET])
        .allow_headers([axum::http::header::ACCEPT])
        .allow_origin(AllowOrigin::list(origins)))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
