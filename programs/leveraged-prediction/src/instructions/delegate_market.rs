use super::*;
use ephemeral_rollups_sdk::anchor::delegate;

pub fn handler(ctx: Context<DelegateMarket>) -> Result<()> {
    let mint = ctx.accounts.protocol_config.collateral_mint;
    ctx.accounts.delegate_market(
        &ctx.accounts.payer,
        &[MARKET_SEED, mint.as_ref()],
        DelegateConfig::default(),
    )?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = protocol_config.admin == payer.key() @ ErrorCode::InvalidConfig)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// CHECK: Program-owned Market PDA before delegation.
    #[account(mut, del, seeds = [MARKET_SEED, protocol_config.collateral_mint.as_ref()], bump)]
    pub market: UncheckedAccount<'info>,
}
