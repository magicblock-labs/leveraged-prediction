pub mod router;
pub mod supervisor;

use anyhow::{bail, Context, Result};
use carbon_core::datasource::Datasource;
use carbon_rpc_program_subscribe_datasource::{
    Filters as ProgramSubscribeFilters, RpcProgramSubscribe,
};
use carbon_rpc_transaction_crawler_datasource::{
    ConnectionConfig as CrawlerConnectionConfig, Filters as CrawlerFilters, RetryConfig,
    RpcTransactionCrawler,
};
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use std::time::Duration;
use url::Url;

pub struct CarbonSourceBoundary {
    pub subscription: RpcProgramSubscribe,
    pub crawler: RpcTransactionCrawler,
}

impl CarbonSourceBoundary {
    pub fn new(http_endpoint: &Url, program_id: Pubkey) -> Result<Self> {
        let ws_endpoint = websocket_url(http_endpoint)?;
        let subscription = RpcProgramSubscribe::new(
            ws_endpoint.as_str().to_owned(),
            ProgramSubscribeFilters::new(program_id, None),
        );
        let crawler = RpcTransactionCrawler::new(
            http_endpoint.as_str().to_owned(),
            program_id,
            CrawlerConnectionConfig::new(
                1,
                Duration::from_secs(5),
                1,
                RetryConfig::no_retry(),
                Some(64),
                Some(64),
                false,
            ),
            CrawlerFilters::new(None, None, None),
            Some(CommitmentConfig::confirmed()),
        );
        if subscription.update_types().is_empty() || crawler.update_types().is_empty() {
            bail!("Carbon datasource did not advertise an update type");
        }
        Ok(Self {
            subscription,
            crawler,
        })
    }

    pub fn is_ready(&self) -> bool {
        !self.subscription.update_types().is_empty() && !self.crawler.update_types().is_empty()
    }
}

pub fn parse_http_url(value: &str, label: &str) -> Result<Url> {
    let mut url = Url::parse(value).with_context(|| format!("{label} is not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("{label} must use http or https");
    }
    url.set_query(None);
    url.set_fragment(None);
    if url.path().is_empty() {
        url.set_path("/");
    }
    Ok(url)
}

pub fn normalize_er_endpoint(fqdn: &str) -> Result<Url> {
    let value = if fqdn.starts_with("http://") || fqdn.starts_with("https://") {
        fqdn.to_owned()
    } else {
        format!("https://{fqdn}")
    };
    parse_http_url(&value, "router ER fqdn")
}

pub fn websocket_url(http: &Url) -> Result<Url> {
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

pub fn redact_url(value: &Url) -> String {
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
    fn recovery_endpoint_normalization_deduplicates_equivalent_routes() {
        let first = normalize_er_endpoint("asia.magicblock.app").unwrap();
        let second = normalize_er_endpoint("https://asia.magicblock.app/?token=ignored").unwrap();
        assert_eq!(first, second);
        assert_eq!(
            websocket_url(&first).unwrap().as_str(),
            "wss://asia.magicblock.app/"
        );
    }
}
