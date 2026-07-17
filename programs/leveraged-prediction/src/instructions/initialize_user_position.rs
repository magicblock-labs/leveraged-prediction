use super::*;
use ephemeral_rollups_sdk::anchor::ephemeral_accounts;

pub fn handler(ctx: Context<InitializeUserPosition>) -> Result<()> {
    let market_rent_floor =
        Rent::get()?.minimum_balance(ctx.accounts.market.to_account_info().data_len());
    let user_position_rent =
        ephemeral_rollups_sdk::ephemeral_accounts::rent((8 + UserPosition::INIT_SPACE) as u32);
    let required_market_lamports = market_rent_floor
        .checked_add(user_position_rent)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        ctx.accounts.market.to_account_info().lamports() >= required_market_lamports,
        ErrorCode::InsufficientSponsorLamports
    );
    ctx.accounts
        .create_ephemeral_user_position((8 + UserPosition::INIT_SPACE) as u32)?;
    let user_position = UserPosition {
        shares: 0,
        pending_withdrawal_shares: 0,
        min_assets_out: 0,
        positions: Vec::new(),
    };
    let mut data = ctx.accounts.user_position.try_borrow_mut_data()?;
    user_position.try_serialize(&mut &mut data[..])?;
    Ok(())
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct InitializeUserPosition<'info> {
    pub user: Signer<'info>,
    #[account(mut, sponsor, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: Market-sponsored ephemeral account, one per market/user pair.
    #[account(mut, eph, seeds = [USER_POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub user_position: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
