use super::*;

pub fn handler(ctx: Context<WithdrawProtocolFees>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    fee_transfer(
        &ctx.accounts.market,
        ctx.accounts.derived_fee_authority.to_account_info(),
        ctx.accounts.fee_token_account.to_account_info(),
        ctx.accounts.destination_token_account.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount,
        ctx.bumps.derived_fee_authority,
    )?;
    emit!(ProtocolFeesWithdrawn {
        market_id: ctx.accounts.market.market_id,
        destination: ctx.accounts.destination_token_account.key(),
        assets: amount,
    });
    Ok(())
}

fn fee_transfer<'info>(
    market: &Account<'info, Market>,
    fee_authority: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    fee_bump: u8,
) -> Result<()> {
    let bump = [fee_bump];
    let market_key = market.key();
    let seeds: &[&[u8]] = &[FEE_AUTHORITY_SEED, market_key.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            SplTransfer {
                from,
                to,
                authority: fee_authority,
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct WithdrawProtocolFees<'info> {
    pub fee_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = fee_authority, has_one = collateral_mint)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: Canonical zero-data PDA derived from the Market.
    #[account(seeds = [FEE_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub derived_fee_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
