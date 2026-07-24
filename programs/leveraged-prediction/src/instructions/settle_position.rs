use super::*;

pub fn handler(ctx: Context<SettlePosition>, nonce: u32, task_salt: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    let Some(position_index) = ctx
        .accounts
        .user_positions
        .position_index(ctx.accounts.market.market_id, nonce)
    else {
        msg!("position already processed or unknown; no-op");
        return Ok(());
    };
    let position = ctx.accounts.user_positions.positions[position_index];
    require!(
        position.task_salt == task_salt,
        ErrorCode::InvalidSettlementTrigger
    );
    let collateral = u64::from(position.collateral);
    let expires_at = i64::from(position.expires_at);
    let now = clock.unix_timestamp;
    let refund_at = expires_at
        .checked_add(SETTLEMENT_BUFFER_SECONDS)
        .ok_or(ErrorCode::MathOverflow)?;
    if now < expires_at {
        msg!("position not expired; no-op");
        return Ok(());
    }
    let is_refund = now >= refund_at;
    let (user_payout, protocol_fee, lp_fee, outcome) = if is_refund {
        (collateral, 0, 0, PositionOutcome::Refunded)
    } else {
        let sample = match read_oracle_price(
            &ctx.accounts.price_update.to_account_info(),
            &clock,
            &ctx.accounts.market.oracle_feed_id,
        ) {
            Ok(Some(sample)) => sample,
            Ok(None) => {
                msg!("qualifying oracle sample not ready; no-op");
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if sample.publish_time < expires_at || sample.publish_time >= refund_at {
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
        let outcome = position_outcome(false, amounts.gross_profit, amounts.loss);
        (
            amounts.user_payout,
            amounts.protocol_fee,
            amounts.lp_fee,
            outcome,
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
        let payout_destination = if is_usable_payout_destination(
            &ctx.accounts.user_token_account.to_account_info(),
            ctx.accounts.collateral_mint.key(),
        ) {
            ctx.accounts.user_token_account.to_account_info()
        } else {
            msg!("payout destination unavailable; using fallback escrow");
            ctx.accounts.payout_escrow_token_account.to_account_info()
        };
        market_transfer(
            &ctx.accounts.market,
            ctx.accounts.pool_token_account.to_account_info(),
            payout_destination,
            ctx.accounts.token_program.to_account_info(),
            user_payout,
        )?;
    }
    ctx.accounts
        .user_positions
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
    emit!(PositionClosed {
        market_id: ctx.accounts.market.market_id,
        position_id: nonce,
        outcome,
        payout_amount: user_payout,
        lp_fee_amount: lp_fee,
        platform_fee_amount: protocol_fee,
    });
    Ok(())
}

const fn position_outcome(is_refund: bool, gross_profit: u64, loss: u64) -> PositionOutcome {
    if is_refund {
        PositionOutcome::Refunded
    } else if gross_profit > 0 {
        PositionOutcome::Won
    } else if loss > 0 {
        PositionOutcome::Lost
    } else {
        PositionOutcome::Breakeven
    }
}

#[derive(Accounts)]
pub struct SettlePosition<'info> {
    /// CHECK: Bound through the UserPositions PDA and the authenticated scheduler signer.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = collateral_mint)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [USER_POSITIONS_SEED, user.key().as_ref()], bump)]
    pub user_positions: Box<Account<'info, UserPositions>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: The user-selected destination may have been closed; the handler validates it before transfer.
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = user_positions)]
    pub payout_escrow_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical zero-data PDA derived from the Market.
    #[account(seeds = [FEE_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub derived_fee_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Box<Account<'info, TokenAccount>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Canonical address is required on every path; owner and payload are checked only while sampling.
    #[account(address = market.oracle)]
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    #[account(
        address = settlement_crank_signer(market.key()) @ ErrorCode::InvalidSettlementTrigger
    )]
    pub crank_signer: Signer<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_outcomes_are_unambiguous() {
        assert_eq!(position_outcome(false, 1, 0), PositionOutcome::Won);
        assert_eq!(position_outcome(false, 0, 1), PositionOutcome::Lost);
        assert_eq!(position_outcome(false, 0, 0), PositionOutcome::Breakeven);
        assert_eq!(position_outcome(true, 1, 1), PositionOutcome::Refunded);
    }

    #[test]
    fn retry_and_noop_paths_have_no_domain_event_emission() {
        let source = include_str!("settle_position.rs");
        let emit_marker = ["emit", "!("].concat();
        assert_eq!(source.matches(&emit_marker).count(), 1);
        assert!(!source.contains(&["Settle", "PositionResult"].concat()));
    }
}
