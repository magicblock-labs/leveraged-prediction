use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateUserPositions>) -> Result<()> {
    ctx.accounts.delegate_user_positions(
        &ctx.accounts.user,
        &[USER_POSITIONS_SEED, ctx.accounts.user.key().as_ref()],
        delegated_state_config(),
    )?;
    Ok(())
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
