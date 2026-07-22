use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateUserLiquidity>, validator: Pubkey) -> Result<()> {
    ctx.accounts.delegate_user_liquidity(
        &ctx.accounts.user,
        &[USER_LIQUIDITY_SEED, ctx.accounts.user.key().as_ref()],
        user_liquidity_delegation_config(validator),
    )?;
    Ok(())
}

fn user_liquidity_delegation_config(validator: Pubkey) -> DelegateConfig {
    let mut config = delegated_state_config();
    config.validator = Some(validator);
    config
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateUserLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: The delegation CPI validates the program-owned PDA from these seeds.
    #[account(mut, del, seeds = [USER_LIQUIDITY_SEED, user.key().as_ref()], bump)]
    pub user_liquidity: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_liquidity_is_pinned_to_the_selected_validator() {
        let validator = Pubkey::new_unique();
        let config = user_liquidity_delegation_config(validator);
        assert_eq!(config.validator, Some(validator));
        assert_eq!(config.commit_frequency_ms, 10_000);
    }
}
