use super::*;

pub fn handler(ctx: Context<ManageWithdrawal>) -> Result<()> {
    let shares = ctx.accounts.user_position.pending_withdrawal_shares;
    require!(shares > 0, ErrorCode::NoPendingWithdrawal);
    ctx.accounts.user_position.pending_withdrawal_shares = 0;
    ctx.accounts.user_position.min_assets_out = 0;
    emit!(WithdrawalCancelled {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        shares,
    });
    Ok(())
}
