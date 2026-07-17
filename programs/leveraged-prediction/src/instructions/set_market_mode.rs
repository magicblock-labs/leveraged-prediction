use super::*;

pub fn handler(ctx: Context<AdminMarket>, mode: MarketMode) -> Result<()> {
    ctx.accounts.market.mode = mode;
    emit!(MarketModeChanged {
        market: ctx.accounts.market.key(),
        mode,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, collateral_mint.key().as_ref()], bump = protocol_config.bump, has_one = admin, has_one = collateral_mint)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub collateral_mint: Account<'info, Mint>,
    #[account(mut, seeds = [MARKET_SEED, collateral_mint.key().as_ref()], bump = market.bump, has_one = collateral_mint)]
    pub market: Account<'info, Market>,
}
