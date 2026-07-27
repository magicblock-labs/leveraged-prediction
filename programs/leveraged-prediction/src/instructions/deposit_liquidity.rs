use super::*;

pub fn handler(ctx: Context<DepositLiquidity>, amount: u64, min_shares_out: u128) -> Result<()> {
    require!(
        ctx.accounts.market.mode == MarketMode::Open,
        ErrorCode::MarketCloseOnly
    );
    require!(ctx.accounts.market.is_no_risk(), ErrorCode::ActiveRisk);
    let first_lp = ctx.accounts.market.total_shares == 0;
    if first_lp {
        require!(
            amount >= MIN_MARKET_EQUITY && amount <= MAX_MARKET_EQUITY,
            ErrorCode::InvalidAmount
        );
    }
    let equity_before = ctx.accounts.pool_token_account.amount;
    require_deposit_capacity(equity_before, amount, MAX_MARKET_EQUITY, first_lp)?;
    let shares = shares_for_deposit(amount, equity_before, ctx.accounts.market.total_shares)?;
    require!(shares >= min_shares_out, ErrorCode::SlippageExceeded);
    ctx.accounts
        .user_liquidity
        .market_or_insert_mut(ctx.accounts.market.market_id)?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.pool_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;
    let user_market = ctx
        .accounts
        .user_liquidity
        .market_or_insert_mut(ctx.accounts.market.market_id)?;
    user_market.shares = user_market
        .shares
        .checked_add(shares)
        .ok_or(ErrorCode::MathOverflow)?;
    ctx.accounts.market.total_shares = ctx
        .accounts
        .market
        .total_shares
        .checked_add(shares)
        .ok_or(ErrorCode::MathOverflow)?;
    emit!(LiquidityDeposited {
        market_id: ctx.accounts.market.market_id,
        user: ctx.accounts.user.key(),
        assets: amount,
        shares,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = collateral_mint)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_LIQUIDITY_SEED, user.key().as_ref()], bump)]
    pub user_liquidity: Account<'info, UserLiquidity>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
