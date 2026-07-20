use super::*;

pub fn handler(ctx: Context<ClaimFallbackPayout>) -> Result<()> {
    let amount = ctx.accounts.payout_escrow_token_account.amount;
    require!(amount > 0, ErrorCode::InvalidAmount);
    let bump = [ctx.bumps.user_positions];
    let user = ctx.accounts.user.key();
    let seeds: &[&[u8]] = &[USER_POSITIONS_SEED, user.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.payout_escrow_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.user_positions.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(FallbackPayoutClaimed {
        user: ctx.accounts.user.key(),
        destination: ctx.accounts.user_token_account.key(),
        assets: amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimFallbackPayout<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = collateral_mint)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [USER_POSITIONS_SEED, user.key().as_ref()], bump)]
    pub user_positions: Account<'info, UserPositions>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = user_positions)]
    pub payout_escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
