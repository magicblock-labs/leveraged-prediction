use super::*;

pub fn handler(ctx: Context<ExecuteWithdrawal>) -> Result<()> {
    require!(ctx.accounts.market.is_no_risk(), ErrorCode::ActiveRisk);
    let market_id = ctx.accounts.market.market_id;
    let user_market = ctx
        .accounts
        .user_liquidity
        .market(market_id)
        .ok_or(ErrorCode::UserLiquidityMarketNotFound)?;
    let shares = user_market.pending_withdrawal_shares;
    let min_assets_out = user_market.min_assets_out;
    require!(shares > 0, ErrorCode::NoPendingWithdrawal);
    let equity_before = ctx.accounts.pool_token_account.amount;
    let assets = assets_for_shares(shares, equity_before, ctx.accounts.market.total_shares)?;
    require!(assets > 0, ErrorCode::InvalidAmount);
    require!(assets >= min_assets_out, ErrorCode::SlippageExceeded);
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
        MIN_MARKET_EQUITY,
    )?;
    market_transfer(
        &ctx.accounts.market,
        ctx.accounts.pool_token_account.to_account_info(),
        ctx.accounts.user_token_account.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        assets,
    )?;
    let user_market = ctx
        .accounts
        .user_liquidity
        .market_mut(market_id)
        .ok_or(ErrorCode::UserLiquidityMarketNotFound)?;
    user_market.shares = user_market
        .shares
        .checked_sub(shares)
        .ok_or(ErrorCode::MathOverflow)?;
    user_market.pending_withdrawal_shares = 0;
    user_market.min_assets_out = 0;
    ctx.accounts.user_liquidity.remove_empty_market(market_id);
    ctx.accounts.market.total_shares = remaining_shares;
    emit!(WithdrawalExecuted {
        market_id,
        user: ctx.accounts.user.key(),
        shares,
        assets,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteWithdrawal<'info> {
    /// CHECK: PDA-bound below; this instruction is permissionless.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = collateral_mint)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_LIQUIDITY_SEED, user.key().as_ref()], bump)]
    pub user_liquidity: Account<'info, UserLiquidity>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
