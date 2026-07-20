use super::*;

pub fn handler(ctx: Context<InitializeProtocolConfig>) -> Result<()> {
    require_valid_fee_authority(ctx.accounts.fee_authority.key())?;
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

fn require_valid_fee_authority(fee_authority: Pubkey) -> Result<()> {
    require!(fee_authority != Pubkey::default(), ErrorCode::InvalidConfig);
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
    #[account(init, payer = admin, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_fee_authority_is_rejected() {
        assert!(require_valid_fee_authority(Pubkey::default()).is_err());
        assert!(require_valid_fee_authority(Pubkey::new_unique()).is_ok());
    }
}
