use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateUserLiquidity>) -> Result<()> {
    ctx.accounts.delegate_user_liquidity(
        &ctx.accounts.user,
        &[USER_LIQUIDITY_SEED, ctx.accounts.user.key().as_ref()],
        delegated_state_config(),
    )?;
    Ok(())
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
