use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use leveraged_prediction_storage::{Source, Storage};
use solana_pubkey::Pubkey;
use url::Url;

use super::router::DelegationRoute;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteGeneration {
    pub generation: u64,
    pub endpoint: Url,
    pub caught_up: bool,
}

#[derive(Clone, Debug, Default)]
pub struct AccountRouteState {
    active: Option<RouteGeneration>,
    draining: Vec<RouteGeneration>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteTransition {
    Unchanged,
    Activated(RouteGeneration),
    OverlapStarted {
        active: RouteGeneration,
        draining: RouteGeneration,
    },
    Undelegated,
}

impl AccountRouteState {
    pub const fn active(&self) -> Option<&RouteGeneration> {
        self.active.as_ref()
    }

    #[cfg(test)]
    pub fn draining(&self) -> &[RouteGeneration] {
        &self.draining
    }

    pub fn apply(&mut self, route: DelegationRoute) -> Result<RouteTransition> {
        if !route.is_delegated {
            self.active = None;
            self.draining.clear();
            return Ok(RouteTransition::Undelegated);
        }
        let endpoint = route
            .endpoint
            .ok_or_else(|| anyhow::anyhow!("delegated route has no endpoint"))?;
        if self.active.as_ref().map(|active| &active.endpoint) == Some(&endpoint) {
            return Ok(RouteTransition::Unchanged);
        }

        let generation = self
            .active
            .as_ref()
            .map_or(1, |active| active.generation.saturating_add(1));
        let new_active = RouteGeneration {
            generation,
            endpoint,
            caught_up: false,
        };
        let transition = if let Some(previous) = self.active.replace(new_active.clone()) {
            self.draining.push(previous.clone());
            RouteTransition::OverlapStarted {
                active: new_active,
                draining: previous,
            }
        } else {
            RouteTransition::Activated(new_active)
        };
        Ok(transition)
    }

    pub fn mark_caught_up(&mut self, endpoint: &Url) -> Result<Vec<RouteGeneration>> {
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("cannot catch up without an active route"))?;
        if &active.endpoint != endpoint {
            bail!("only the active route can complete overlap catch-up");
        }
        active.caught_up = true;
        Ok(std::mem::take(&mut self.draining))
    }
}

#[derive(Clone, Debug, Default)]
pub struct SourceSupervisor {
    accounts: BTreeMap<Pubkey, AccountRouteState>,
}

#[derive(Clone, Debug)]
pub struct PersistedRoute {
    pub source: Source,
    pub generation: i64,
}

#[allow(clippy::too_many_arguments)]
pub async fn persist_route(
    storage: &Storage,
    network: &str,
    program_id: &Pubkey,
    account: &Pubkey,
    account_type: &str,
    market_id: Option<u16>,
    user_pubkey: Option<&Pubkey>,
    route: &DelegationRoute,
) -> Result<Option<PersistedRoute>> {
    let source = match route.endpoint.as_ref() {
        Some(endpoint) => Some(
            storage
                .ensure_source(network, "er", endpoint.as_str())
                .await?,
        ),
        None => None,
    };
    let mut tx = storage.pool().begin().await?;
    let previous = sqlx::query_as::<_, (i64, Option<String>)>(
        r#"
        SELECT route_generation, current_er_endpoint
        FROM indexer.tracked_accounts
        WHERE network = $1 AND program_id = $2 AND pubkey = $3
        FOR UPDATE
        "#,
    )
    .bind(network)
    .bind(program_id.to_string())
    .bind(account.to_string())
    .fetch_optional(&mut *tx)
    .await?;
    let endpoint = route.endpoint.as_ref().map(Url::to_string);
    let generation = previous.as_ref().map_or(1, |(generation, previous)| {
        if previous == &endpoint {
            *generation
        } else {
            generation.saturating_add(1)
        }
    });
    sqlx::query(
        r#"
        INSERT INTO indexer.tracked_accounts (
            network, program_id, pubkey, account_type, market_id, user_pubkey,
            current_er_source_id, current_er_endpoint, route_generation, route_checked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
        ON CONFLICT (network, program_id, pubkey)
        DO UPDATE SET
            account_type = EXCLUDED.account_type,
            market_id = EXCLUDED.market_id,
            user_pubkey = EXCLUDED.user_pubkey,
            current_er_source_id = EXCLUDED.current_er_source_id,
            current_er_endpoint = EXCLUDED.current_er_endpoint,
            route_generation = EXCLUDED.route_generation,
            route_checked_at = now(),
            updated_at = now()
        "#,
    )
    .bind(network)
    .bind(program_id.to_string())
    .bind(account.to_string())
    .bind(account_type)
    .bind(market_id.map(i32::from))
    .bind(user_pubkey.map(ToString::to_string))
    .bind(source.as_ref().map(|item| item.id))
    .bind(endpoint.as_deref())
    .bind(generation)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO indexer.route_observations (
            network, program_id, pubkey, is_delegated, er_source_id,
            er_endpoint, route_generation
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (network, program_id, pubkey, route_generation) DO NOTHING
        "#,
    )
    .bind(network)
    .bind(program_id.to_string())
    .bind(account.to_string())
    .bind(route.is_delegated)
    .bind(source.as_ref().map(|item| item.id))
    .bind(endpoint.as_deref())
    .bind(generation)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(source.map(|source| PersistedRoute { source, generation }))
}

impl SourceSupervisor {
    pub fn apply(&mut self, account: Pubkey, route: DelegationRoute) -> Result<RouteTransition> {
        self.accounts.entry(account).or_default().apply(route)
    }

    pub fn mark_caught_up(
        &mut self,
        account: &Pubkey,
        endpoint: &Url,
    ) -> Result<Vec<RouteGeneration>> {
        self.accounts
            .get_mut(account)
            .ok_or_else(|| anyhow::anyhow!("account is not supervised"))?
            .mark_caught_up(endpoint)
    }

    pub fn unique_active_endpoints(&self) -> BTreeSet<Url> {
        self.accounts
            .values()
            .filter_map(AccountRouteState::active)
            .map(|route| route.endpoint.clone())
            .collect()
    }

    pub fn ensure_compatible_routes<'a>(
        &self,
        accounts: impl IntoIterator<Item = &'a Pubkey>,
    ) -> Result<Option<Url>> {
        let routes = accounts
            .into_iter()
            .filter_map(|account| self.accounts.get(account))
            .filter_map(AccountRouteState::active)
            .map(|route| route.endpoint.clone())
            .collect::<BTreeSet<_>>();
        if routes.len() > 1 {
            bail!("tracked accounts resolve to incompatible ER endpoints");
        }
        Ok(routes.into_iter().next())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::normalize_er_endpoint;

    fn delegated(endpoint: &str) -> DelegationRoute {
        DelegationRoute {
            is_delegated: true,
            endpoint: Some(normalize_er_endpoint(endpoint).unwrap()),
        }
    }

    #[test]
    fn recovery_route_change_requires_new_source_catch_up_before_retirement() {
        let account = Pubkey::new_from_array([7; 32]);
        let mut supervisor = SourceSupervisor::default();
        let first = normalize_er_endpoint("old.example").unwrap();
        let second = normalize_er_endpoint("new.example").unwrap();

        assert!(matches!(
            supervisor.apply(account, delegated("old.example")).unwrap(),
            RouteTransition::Activated(_)
        ));
        supervisor.mark_caught_up(&account, &first).unwrap();
        let transition = supervisor.apply(account, delegated("new.example")).unwrap();
        assert!(matches!(transition, RouteTransition::OverlapStarted { .. }));
        assert_eq!(supervisor.accounts[&account].draining().len(), 1);

        let retired = supervisor.mark_caught_up(&account, &second).unwrap();
        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0].endpoint, first);
        assert!(supervisor.accounts[&account].draining().is_empty());
    }

    #[test]
    fn recovery_same_route_is_deduplicated_across_accounts() {
        let mut supervisor = SourceSupervisor::default();
        supervisor
            .apply(Pubkey::new_from_array([1; 32]), delegated("same.example"))
            .unwrap();
        supervisor
            .apply(Pubkey::new_from_array([2; 32]), delegated("same.example"))
            .unwrap();
        assert_eq!(supervisor.unique_active_endpoints().len(), 1);
    }

    #[test]
    fn recovery_mixed_routes_are_rejected_for_one_state_group() {
        let first = Pubkey::new_from_array([1; 32]);
        let second = Pubkey::new_from_array([2; 32]);
        let mut supervisor = SourceSupervisor::default();
        supervisor.apply(first, delegated("first.example")).unwrap();
        supervisor
            .apply(second, delegated("second.example"))
            .unwrap();
        assert!(supervisor
            .ensure_compatible_routes([&first, &second])
            .is_err());
    }
}
