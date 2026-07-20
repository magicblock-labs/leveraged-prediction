use super::*;

pub fn handler(_ctx: Context<InitializeUserPositions>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeUserPositions<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPositions::INIT_SPACE,
        seeds = [USER_POSITIONS_SEED, user.key().as_ref()],
        bump
    )]
    pub user_positions: Account<'info, UserPositions>,
    pub system_program: Program<'info, System>,
}
