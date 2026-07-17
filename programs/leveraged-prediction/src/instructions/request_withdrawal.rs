use super::*;

pub fn handler(ctx: Context<ManageWithdrawal>, shares: u128, min_assets_out: u64) -> Result<()> {
    require!(
        shares > 0 && shares <= ctx.accounts.user_position.shares,
        ErrorCode::InvalidAmount
    );
    require!(
        ctx.accounts.user_position.pending_withdrawal_shares == 0,
        ErrorCode::WithdrawalAlreadyPending
    );
    ctx.accounts.user_position.pending_withdrawal_shares = shares;
    ctx.accounts.user_position.min_assets_out = min_assets_out;
    emit!(WithdrawalRequested {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        shares,
        min_assets_out,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ManageWithdrawal<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub user_position: Account<'info, UserPosition>,
}
