use super::*;

pub fn handler(ctx: Context<ManageWithdrawal>) -> Result<()> {
    let user_market = ctx
        .accounts
        .user_liquidity
        .market_mut(ctx.accounts.market.market_id)
        .ok_or(ErrorCode::UserLiquidityMarketNotFound)?;
    let shares = user_market.pending_withdrawal_shares;
    require!(shares > 0, ErrorCode::NoPendingWithdrawal);
    user_market.pending_withdrawal_shares = 0;
    user_market.min_assets_out = 0;
    emit!(WithdrawalCancelled {
        market_id: ctx.accounts.market.market_id,
        user: ctx.accounts.user.key(),
        shares,
    });
    Ok(())
}
