use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde::Deserialize;
use solana_pubkey::Pubkey;
use url::Url;

use super::normalize_er_endpoint;

const ROUTER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationRoute {
    pub is_delegated: bool,
    pub endpoint: Option<Url>,
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

#[derive(Clone, Debug)]
pub struct RouterClient {
    endpoint: Url,
    client: Client,
}

impl RouterClient {
    pub fn new(endpoint: Url) -> Self {
        Self {
            endpoint,
            client: Client::new(),
        }
    }

    pub async fn resolve(&self, account: &Pubkey) -> Result<DelegationRoute> {
        let endpoint = self
            .endpoint
            .join("getDelegationStatus")
            .context("failed to construct router delegation endpoint")?;
        let response = tokio::time::timeout(
            ROUTER_TIMEOUT,
            self.client
                .post(endpoint)
                .json(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": format!("indexer-route-{account}"),
                    "method": "getDelegationStatus",
                    "params": [account.to_string()],
                }))
                .send(),
        )
        .await
        .context("router request timed out")?
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
        let status = response.result.context("router response had no result")?;
        let endpoint = status
            .fqdn
            .as_deref()
            .map(normalize_er_endpoint)
            .transpose()?;
        if status.is_delegated && endpoint.is_none() {
            bail!("router reports delegated account {account} without an ER endpoint");
        }
        Ok(DelegationRoute {
            is_delegated: status.is_delegated,
            endpoint,
        })
    }
}
