use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateMarket>, market_id: u16, validator: Pubkey) -> Result<()> {
    let market_id = market_id.to_le_bytes();
    ctx.accounts.delegate_market(
        &ctx.accounts.payer,
        &[MARKET_SEED, market_id.as_ref()],
        market_delegation_config(validator),
    )?;
    Ok(())
}

fn market_delegation_config(validator: Pubkey) -> DelegateConfig {
    let mut config = delegated_state_config();
    config.validator = Some(validator);
    config
}

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, constraint = protocol_config.admin == payer.key() @ ErrorCode::InvalidConfig)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// CHECK: Program-owned Market PDA before delegation.
    #[account(mut, del, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump)]
    pub market: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_is_pinned_to_the_selected_validator() {
        let validator = Pubkey::new_unique();
        let config = market_delegation_config(validator);
        assert_eq!(config.validator, Some(validator));
        assert_eq!(config.commit_frequency_ms, 10_000);
    }
}
