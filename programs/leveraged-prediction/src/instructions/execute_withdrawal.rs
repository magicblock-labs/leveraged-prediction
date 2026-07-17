use super::*;

pub fn handler(ctx: Context<ExecuteWithdrawal>) -> Result<()> {
    require!(ctx.accounts.market.is_no_risk(), ErrorCode::ActiveRisk);
    let shares = ctx.accounts.user_position.pending_withdrawal_shares;
    require!(shares > 0, ErrorCode::NoPendingWithdrawal);
    let equity_before = ctx.accounts.pool_token_account.amount;
    let assets = assets_for_shares(shares, equity_before, ctx.accounts.market.total_shares)?;
    require!(assets > 0, ErrorCode::InvalidAmount);
    require!(
        assets >= ctx.accounts.user_position.min_assets_out,
        ErrorCode::SlippageExceeded
    );
    let remaining_equity = equity_before
        .checked_sub(assets)
        .ok_or(ErrorCode::MathOverflow)?;
    let remaining_shares = ctx
        .accounts
        .market
        .total_shares
        .checked_sub(shares)
        .ok_or(ErrorCode::MathOverflow)?;
    require_valid_withdrawal_remainder(
        ctx.accounts.market.mode,
        remaining_equity,
        remaining_shares,
        MIN_INITIAL_LIQUIDITY,
    )?;
    market_transfer(
        &ctx.accounts.market,
        ctx.accounts.pool_token_account.to_account_info(),
        ctx.accounts.user_token_account.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        assets,
    )?;
    ctx.accounts.user_position.shares = ctx
        .accounts
        .user_position
        .shares
        .checked_sub(shares)
        .ok_or(ErrorCode::MathOverflow)?;
    ctx.accounts.user_position.pending_withdrawal_shares = 0;
    ctx.accounts.user_position.min_assets_out = 0;
    ctx.accounts.market.total_shares = remaining_shares;
    emit!(WithdrawalExecuted {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        shares,
        assets,
        equity_after: remaining_equity,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteWithdrawal<'info> {
    /// CHECK: PDA-bound below; this instruction is permissionless.
    pub user: UncheckedAccount<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub user_position: Account<'info, UserPosition>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
