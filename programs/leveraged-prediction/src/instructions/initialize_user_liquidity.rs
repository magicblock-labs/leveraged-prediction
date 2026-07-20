use super::*;

pub fn handler(_ctx: Context<InitializeUserLiquidity>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeUserLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserLiquidity::INIT_SPACE,
        seeds = [USER_LIQUIDITY_SEED, user.key().as_ref()],
        bump
    )]
    pub user_liquidity: Account<'info, UserLiquidity>,
    pub system_program: Program<'info, System>,
}
