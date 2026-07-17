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
            amount >= MIN_INITIAL_LIQUIDITY && amount <= MAX_INITIAL_LIQUIDITY,
            ErrorCode::InvalidAmount
        );
    }
    let equity_before = ctx.accounts.pool_token_account.amount;
    let equity_after =
        require_deposit_capacity(equity_before, amount, MAX_INITIAL_LIQUIDITY, first_lp)?;
    let shares = shares_for_deposit(amount, equity_before, ctx.accounts.market.total_shares)?;
    require!(shares >= min_shares_out, ErrorCode::SlippageExceeded);
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
    ctx.accounts.user_position.shares = ctx
        .accounts
        .user_position
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
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        assets: amount,
        shares,
        equity_after,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub user_position: Account<'info, UserPosition>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
