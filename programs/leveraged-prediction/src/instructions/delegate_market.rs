use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateMarket>, market_id: u16) -> Result<()> {
    let market_id = market_id.to_le_bytes();
    ctx.accounts.delegate_market(
        &ctx.accounts.payer,
        &[MARKET_SEED, market_id.as_ref()],
        delegated_state_config(),
    )?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, constraint = protocol_config.admin == payer.key() @ ErrorCode::InvalidConfig)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// CHECK: Program-owned Market PDA before delegation.
    #[account(mut, del, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump)]
    pub market: UncheckedAccount<'info>,
}
