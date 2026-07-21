use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateUserPositions>, validator: Pubkey) -> Result<()> {
    ctx.accounts.delegate_user_positions(
        &ctx.accounts.user,
        &[USER_POSITIONS_SEED, ctx.accounts.user.key().as_ref()],
        user_positions_delegation_config(validator),
    )?;
    Ok(())
}

fn user_positions_delegation_config(validator: Pubkey) -> DelegateConfig {
    let mut config = delegated_state_config();
    config.validator = Some(validator);
    config
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateUserPositions<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: The delegation CPI validates the program-owned PDA from these seeds.
    #[account(mut, del, seeds = [USER_POSITIONS_SEED, user.key().as_ref()], bump)]
    pub user_positions: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_positions_are_pinned_to_the_client_selected_market_validator() {
        let validator = Pubkey::new_unique();
        let config = user_positions_delegation_config(validator);
        assert_eq!(config.validator, Some(validator));
        assert_eq!(config.commit_frequency_ms, 10_000);
    }
}
