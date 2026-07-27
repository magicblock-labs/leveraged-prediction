use super::*;

pub fn handler(ctx: Context<AdminMarket>, mode: MarketMode) -> Result<()> {
    ctx.accounts.market.mode = mode;
    emit!(MarketModeChanged {
        market_id: ctx.accounts.market.market_id,
        mode,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = admin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
}
