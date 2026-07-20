use super::*;

pub fn handler(
    ctx: Context<InitializeMarket>,
    market_id: u16,
    oracle: Pubkey,
    oracle_feed_id: [u8; 32],
    sponsor_lamports: u64,
) -> Result<()> {
    require!(
        oracle != Pubkey::default() && oracle_feed_id != [0; 32],
        ErrorCode::InvalidConfig
    );

    if sponsor_lamports > 0 {
        transfer_lamports(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                LamportsTransfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.market.to_account_info(),
                },
            ),
            sponsor_lamports,
        )?;
    }

    let market = &mut ctx.accounts.market;
    market.market_id = market_id;
    market.oracle = oracle;
    market.oracle_feed_id = oracle_feed_id;
    market.total_shares = 0;
    market.open_collateral = 0;
    market.risk_epoch_equity = 0;
    market.active_positions = 0;
    market.next_position_nonce = 0;
    market.mode = MarketMode::Open;
    market.bump = ctx.bumps.market;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub collateral_mint: Account<'info, Mint>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = admin, has_one = collateral_mint)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump)]
    pub market: Account<'info, Market>,
    #[account(init_if_needed, payer = admin, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Account<'info, TokenAccount>,
    /// CHECK: Zero-data PDA used only as the canonical fee ATA authority on ER.
    #[account(seeds = [FEE_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub derived_fee_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = admin, associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
