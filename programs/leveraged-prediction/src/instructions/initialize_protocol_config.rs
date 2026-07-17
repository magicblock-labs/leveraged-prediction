use super::*;

pub fn handler(ctx: Context<InitializeProtocolConfig>) -> Result<()> {
    require!(
        ctx.accounts.collateral_mint.decimals == COLLATERAL_DECIMALS,
        ErrorCode::InvalidConfig
    );
    let config = &mut ctx.accounts.protocol_config;
    config.admin = ctx.accounts.admin.key();
    config.fee_authority = ctx.accounts.fee_authority.key();
    config.collateral_mint = ctx.accounts.collateral_mint.key();
    config.bump = ctx.bumps.protocol_config;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProtocolConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Receives protocol-fee withdrawals.
    pub fee_authority: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ErrorCode::InvalidConfig)]
    pub program: Program<'info, crate::program::LeveragedPrediction>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ ErrorCode::InvalidConfig)]
    pub program_data: Account<'info, ProgramData>,
    pub collateral_mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [CONFIG_SEED, collateral_mint.key().as_ref()], bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}
