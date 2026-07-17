use super::*;

pub fn handler(ctx: Context<SettlePosition>, nonce: u32, task_salt: [u8; 32]) -> Result<()> {
    let expected_crank = hydra_crank_address(
        ctx.accounts.market.key(),
        ctx.accounts.user.key(),
        nonce,
        task_salt,
    );
    require_hydra_trigger(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        expected_crank,
    )?;
    let clock = Clock::get()?;
    let Some(position_index) = ctx
        .accounts
        .user_position
        .positions
        .iter()
        .position(|position| position.nonce == nonce)
    else {
        emit!(SettlePositionResult {
            nonce,
            outcome: SettleOutcome::AlreadyProcessed,
            processed_at: clock.unix_timestamp,
            expires_at: 0,
            refund_at: 0,
            entry_price: 0,
            settlement_price: 0,
            oracle_publish_time: 0,
        });
        msg!("position already processed or unknown; no-op");
        return Ok(());
    };
    let position = ctx.accounts.user_position.positions[position_index];
    require!(
        position.task_salt == task_salt,
        ErrorCode::InvalidHydraTrigger
    );
    let collateral = u64::from(position.collateral);
    let expires_at = i64::from(position.expires_at);
    let now = clock.unix_timestamp;
    let refund_at = expires_at
        .checked_add(SETTLEMENT_BUFFER_SECONDS)
        .ok_or(ErrorCode::MathOverflow)?;
    if now < expires_at {
        emit!(SettlePositionResult {
            nonce,
            outcome: SettleOutcome::PreExpiry,
            processed_at: now,
            expires_at,
            refund_at,
            entry_price: position.entry_price,
            settlement_price: 0,
            oracle_publish_time: 0,
        });
        msg!("position not expired; no-op");
        return Ok(());
    }
    let is_refund = now >= refund_at;
    let (user_payout, protocol_fee, settlement_price, oracle_publish_time) = if is_refund {
        (collateral, 0, 0, 0)
    } else {
        let sample = match read_oracle_price(&ctx.accounts.price_update.to_account_info(), &clock) {
            Ok(sample) => sample,
            Err(_) => {
                emit!(SettlePositionResult {
                    nonce,
                    outcome: SettleOutcome::OracleNotReady,
                    processed_at: now,
                    expires_at,
                    refund_at,
                    entry_price: position.entry_price,
                    settlement_price: 0,
                    oracle_publish_time: 0,
                });
                msg!("qualifying oracle sample not ready; no-op");
                return Ok(());
            }
        };
        if sample.publish_time < expires_at || sample.publish_time >= refund_at {
            emit!(SettlePositionResult {
                nonce,
                outcome: SettleOutcome::OracleOutsideWindow,
                processed_at: now,
                expires_at,
                refund_at,
                entry_price: position.entry_price,
                settlement_price: sample.price,
                oracle_publish_time: sample.publish_time,
            });
            msg!("oracle sample outside settlement interval; no-op");
            return Ok(());
        }
        let amounts = calculate_settlement(
            collateral,
            position.entry_price,
            sample.price,
            position.direction,
            LEVERAGE,
            PROFIT_FEE_BPS,
            PROTOCOL_FEE_SHARE_BPS,
        )?;
        (
            amounts.user_payout,
            amounts.protocol_fee,
            sample.price,
            sample.publish_time,
        )
    };

    if protocol_fee > 0 {
        market_transfer(
            &ctx.accounts.market,
            ctx.accounts.pool_token_account.to_account_info(),
            ctx.accounts.fee_token_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            protocol_fee,
        )?;
    }
    if user_payout > 0 {
        market_transfer(
            &ctx.accounts.market,
            ctx.accounts.pool_token_account.to_account_info(),
            ctx.accounts.user_token_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            user_payout,
        )?;
    }
    ctx.accounts
        .user_position
        .positions
        .swap_remove(position_index);
    ctx.accounts.market.open_collateral = ctx
        .accounts
        .market
        .open_collateral
        .checked_sub(collateral)
        .ok_or(ErrorCode::MathOverflow)?;
    ctx.accounts.market.active_positions = ctx
        .accounts
        .market
        .active_positions
        .checked_sub(1)
        .ok_or(ErrorCode::MathOverflow)?;
    emit!(SettlePositionResult {
        nonce,
        outcome: if is_refund {
            SettleOutcome::Refunded
        } else {
            SettleOutcome::Settled
        },
        processed_at: now,
        expires_at,
        refund_at,
        entry_price: position.entry_price,
        settlement_price,
        oracle_publish_time,
    });
    Ok(())
}

pub(crate) fn require_hydra_trigger(
    instructions_sysvar: &AccountInfo<'_>,
    expected_crank: Pubkey,
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(ErrorCode::InvalidHydraTrigger))?;
    let previous_index = current_index
        .checked_sub(1)
        .ok_or(ErrorCode::InvalidHydraTrigger)?;
    let previous = load_instruction_at_checked(usize::from(previous_index), instructions_sysvar)
        .map_err(|_| error!(ErrorCode::InvalidHydraTrigger))?;
    require_keys_eq!(
        previous.program_id,
        HYDRA_EPHEMERAL_PROGRAM_ID,
        ErrorCode::InvalidHydraTrigger
    );
    require!(
        previous.data == [hydra_api::consts::ix::TRIGGER],
        ErrorCode::InvalidHydraTrigger
    );
    let crank = previous
        .accounts
        .first()
        .ok_or(ErrorCode::InvalidHydraTrigger)?;
    require_keys_eq!(crank.pubkey, expected_crank, ErrorCode::InvalidHydraTrigger);
    Ok(())
}

#[derive(Accounts)]
pub struct SettlePosition<'info> {
    /// CHECK: Bound through the UserPosition PDA and the authenticated Hydra task.
    pub user: UncheckedAccount<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub user_position: Account<'info, UserPosition>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    /// CHECK: Canonical zero-data PDA derived from the Market.
    #[account(seeds = [FEE_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub derived_fee_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: Canonical address and owner are required on every idempotent/no-op/refund path.
    #[account(address = ORACLE_ACCOUNT, owner = ORACLE_PROGRAM_ID)]
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Parsed to authenticate the immediately preceding Hydra Trigger.
    #[account(address = Instructions::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
