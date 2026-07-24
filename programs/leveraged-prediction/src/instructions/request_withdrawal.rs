use super::*;

pub fn handler(ctx: Context<ManageWithdrawal>, shares: u128, min_assets_out: u64) -> Result<()> {
    let user_market = ctx
        .accounts
        .user_liquidity
        .market_mut(ctx.accounts.market.market_id)
        .ok_or(ErrorCode::UserLiquidityMarketNotFound)?;
    require!(
        shares > 0 && shares <= user_market.shares,
        ErrorCode::InvalidAmount
    );
    require!(
        user_market.pending_withdrawal_shares == 0,
        ErrorCode::WithdrawalAlreadyPending
    );
    user_market.pending_withdrawal_shares = shares;
    user_market.min_assets_out = min_assets_out;
    emit!(WithdrawalRequested {
        market_id: ctx.accounts.market.market_id,
        user: ctx.accounts.user.key(),
        shares,
        min_assets_out,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ManageWithdrawal<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_LIQUIDITY_SEED, user.key().as_ref()], bump)]
    pub user_liquidity: Account<'info, UserLiquidity>,
}
