use super::*;
use anchor_lang::solana_program::program_option::COption;
use session_keys::{SessionTokenV2, SessionV2};

pub fn handler(
    ctx: Context<OpenPosition>,
    nonce: u32,
    task_salt: [u8; 32],
    direction: Direction,
    collateral: u64,
    min_entry_price: i64,
    max_entry_price: i64,
) -> Result<()> {
    require!(task_salt != [0_u8; 32], ErrorCode::InvalidHydraCrank);
    require!(
        ctx.accounts.market.mode == MarketMode::Open,
        ErrorCode::MarketCloseOnly
    );
    require_collateral_bounds(collateral, MIN_POSITION_COLLATERAL, MAX_POSITION_COLLATERAL)?;
    require!(
        nonce == ctx.accounts.market.next_position_nonce,
        ErrorCode::InvalidNonce
    );
    crate::require_market_financial_capacity(ctx.accounts.market.active_positions)?;
    ctx.accounts.user_positions.require_capacity()?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let sample = read_oracle_price(
        &ctx.accounts.price_update.to_account_info(),
        &clock,
        &ctx.accounts.market.oracle_feed_id,
    )?
    .ok_or(ErrorCode::InvalidOraclePrice)?;
    require!(
        sample.price >= min_entry_price && sample.price <= max_entry_price,
        ErrorCode::SlippageExceeded
    );
    require_session_token_delegate(
        ctx.accounts.user_token_account.delegate,
        ctx.accounts.user_token_account.delegated_amount,
        ctx.accounts.session_signer.key(),
        collateral,
    )?;

    let pool_before = ctx.accounts.pool_token_account.amount;
    let epoch_equity = if ctx.accounts.market.active_positions == 0 {
        bounded_risk_epoch_equity(pool_before, MAX_MARKET_EQUITY)
    } else {
        ctx.accounts.market.risk_epoch_equity
    };
    require_open_liquidity(
        ctx.accounts.market.total_shares,
        epoch_equity,
        pool_before,
        MIN_MARKET_EQUITY,
    )?;
    let user_open_collateral = ctx
        .accounts
        .user_positions
        .open_collateral(ctx.accounts.market.market_id)?;
    require_user_open_collateral_capacity(
        user_open_collateral,
        collateral,
        epoch_equity,
        USER_OPEN_COLLATERAL_BPS,
    )?;
    let open_collateral_after = ctx
        .accounts
        .market
        .open_collateral
        .checked_add(collateral)
        .ok_or(ErrorCode::MathOverflow)?;
    require_post_open_solvency(
        pool_before,
        ctx.accounts.market.open_collateral,
        open_collateral_after,
        SAFETY_BUFFER_BPS,
    )?;

    let task_seed = hydra_task_seed(
        ctx.accounts.market.key(),
        ctx.accounts.user.key(),
        nonce,
        task_salt,
    );
    let scheduled_data = crate::instruction::SettlePosition { nonce, task_salt }.data();
    let scheduled_metas = settle_position_schedule_metas(crate::accounts::SettlePosition {
        user: ctx.accounts.user.key(),
        protocol_config: ctx.accounts.protocol_config.key(),
        market: ctx.accounts.market.key(),
        user_positions: ctx.accounts.user_positions.key(),
        pool_token_account: ctx.accounts.pool_token_account.key(),
        user_token_account: ctx.accounts.user_token_account.key(),
        payout_escrow_token_account: ctx.accounts.payout_escrow_token_account.key(),
        derived_fee_authority: ctx.accounts.derived_fee_authority.key(),
        fee_token_account: ctx.accounts.fee_token_account.key(),
        collateral_mint: ctx.accounts.collateral_mint.key(),
        price_update: ctx.accounts.price_update.key(),
        token_program: ctx.accounts.token_program.key(),
        instructions_sysvar: Instructions::id(),
    })?;
    let scheduled = [ScheduledIx {
        program_id: crate::ID,
        metas: &scheduled_metas,
        data: &scheduled_data,
    }];
    let task_args = HydraCreateArgs {
        seed: task_seed,
        authority: ctx.accounts.task_payer.key().to_bytes(),
        start_slot: clock
            .slot
            .checked_add(HYDRA_FIRST_ATTEMPT_DELAY_SLOTS)
            .ok_or(ErrorCode::MathOverflow)?,
        interval_slots: HYDRA_INTERVAL_SLOTS,
        remaining: HYDRA_REMAINING_ATTEMPTS,
        priority_tip: 0,
        cu_limit: HYDRA_COMPUTE_UNIT_LIMIT,
        scheduled: &scheduled,
    };
    let allocation_region_len = CREATE_IX_HEADER_LEN
        .checked_add(
            SERIALIZED_META_SIZE
                .checked_mul(scheduled_metas.len())
                .ok_or(ErrorCode::MathOverflow)?,
        )
        .and_then(|value| value.checked_add(scheduled_data.len()))
        .and_then(|value| value.checked_add(MAX_INSTRUCTIONS))
        .ok_or(ErrorCode::MathOverflow)?;
    let task_rent = Rent::get()?.minimum_balance(crank_account_size(allocation_region_len));
    let reward_budget = HYDRA_REMAINING_ATTEMPTS
        .checked_add(1)
        .and_then(|attempts| attempts.checked_mul(HYDRA_CRANKER_REWARD))
        .ok_or(ErrorCode::MathOverflow)?;
    let task_cost = task_rent
        .checked_add(reward_budget)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        ctx.accounts.task_payer.lamports() >= task_cost,
        ErrorCode::InsufficientHydraTaskLamports
    );
    transfer_lamports(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            LamportsTransfer {
                from: ctx.accounts.task_payer.to_account_info(),
                to: ctx.accounts.hydra_crank.to_account_info(),
            },
        ),
        task_rent,
    )?;
    hydra_cpi::create(
        &ctx.accounts.task_payer.to_account_info(),
        &ctx.accounts.hydra_crank.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &task_args,
    )
    .map_err(|_| error!(ErrorCode::HydraTaskCreationFailed))?;
    transfer_lamports(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            LamportsTransfer {
                from: ctx.accounts.task_payer.to_account_info(),
                to: ctx.accounts.hydra_crank.to_account_info(),
            },
        ),
        reward_budget,
    )?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.pool_token_account.to_account_info(),
                authority: ctx.accounts.session_signer.to_account_info(),
            },
        ),
        collateral,
    )?;
    let expires_at = now
        .checked_add(POSITION_DURATION_SECONDS)
        .ok_or(ErrorCode::MathOverflow)?;
    let (compact_collateral, compact_expires_at) = compact_position_values(collateral, expires_at)?;
    ctx.accounts.user_positions.positions.push(CompactPosition {
        market_id: ctx.accounts.market.market_id,
        nonce,
        task_salt,
        collateral: compact_collateral,
        entry_price: sample.price,
        expires_at: compact_expires_at,
        direction,
    });
    ctx.accounts.market.risk_epoch_equity = epoch_equity;
    ctx.accounts.market.open_collateral = open_collateral_after;
    ctx.accounts.market.active_positions = ctx
        .accounts
        .market
        .active_positions
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;
    ctx.accounts.market.next_position_nonce =
        nonce.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

fn require_session_token_delegate(
    delegate: COption<Pubkey>,
    delegated_amount: u64,
    session_signer: Pubkey,
    collateral: u64,
) -> Result<()> {
    require!(
        delegate == COption::Some(session_signer),
        ErrorCode::InvalidSessionTokenDelegate
    );
    require!(
        delegated_amount >= collateral,
        ErrorCode::InsufficientSessionTokenAllowance
    );
    Ok(())
}

fn settle_position_schedule_metas(
    accounts: crate::accounts::SettlePosition,
) -> Result<Vec<SchedMeta>> {
    accounts
        .to_account_metas(None)
        .into_iter()
        .map(|meta| {
            require!(!meta.is_signer, ErrorCode::InvalidHydraCrank);
            Ok(if meta.is_writable {
                SchedMeta::writable(meta.pubkey)
            } else {
                SchedMeta::readonly(meta.pubkey)
            })
        })
        .collect()
}

#[derive(Accounts, SessionV2)]
#[instruction(nonce: u32, task_salt: [u8; 32])]
pub struct OpenPosition<'info> {
    /// CHECK: Wallet authority bound to UserPositions, the session token, and the token account.
    pub user: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(mut)]
    pub task_payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = protocol_config.bump, has_one = collateral_mint)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [USER_POSITIONS_SEED, user.key().as_ref()], bump)]
    pub user_positions: Box<Account<'info, UserPositions>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical zero-data PDA used by the scheduled settlement instruction.
    #[account(seeds = [FEE_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub derived_fee_authority: UncheckedAccount<'info>,
    #[account(associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ ErrorCode::InvalidTokenOwner,
        constraint = user_token_account.mint == collateral_mint.key() @ ErrorCode::TokenMintMismatch
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    #[account(associated_token::mint = collateral_mint, associated_token::authority = user_positions)]
    pub payout_escrow_token_account: Box<Account<'info, TokenAccount>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Canonical address is constrained here; payload and owner are parsed in the handler.
    #[account(address = market.oracle)]
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Address is derived from the Market, user, position nonce, and task salt.
    #[account(mut, address = hydra_crank_address(market.key(), user.key(), nonce, task_salt) @ ErrorCode::InvalidHydraCrank)]
    pub hydra_crank: UncheckedAccount<'info>,
    /// CHECK: Canonical consolidated Hydra program deployed on the target ER.
    #[account(address = HYDRA_PROGRAM_ID, executable)]
    pub hydra_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[session(signer = session_signer, authority = user.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_settlement_uses_generated_account_order_and_writability() {
        let keys = (0..13).map(|_| Pubkey::new_unique()).collect::<Vec<_>>();
        let generated = crate::accounts::SettlePosition {
            user: keys[0],
            protocol_config: keys[1],
            market: keys[2],
            user_positions: keys[3],
            pool_token_account: keys[4],
            user_token_account: keys[5],
            payout_escrow_token_account: keys[6],
            derived_fee_authority: keys[7],
            fee_token_account: keys[8],
            collateral_mint: keys[9],
            price_update: keys[10],
            token_program: keys[11],
            instructions_sysvar: keys[12],
        };
        let expected = generated.to_account_metas(None);
        assert!(expected.iter().all(|meta| !meta.is_signer));

        let actual = settle_position_schedule_metas(generated).unwrap();
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.pubkey, expected.pubkey);
            assert_eq!(actual.is_writable, expected.is_writable);
        }
    }

    #[test]
    fn session_delegate_must_match_and_cover_collateral() {
        let session_signer = Pubkey::new_unique();
        assert!(require_session_token_delegate(
            COption::Some(session_signer),
            25_000_000,
            session_signer,
            25_000_000,
        )
        .is_ok());
        assert!(require_session_token_delegate(
            COption::None,
            25_000_000,
            session_signer,
            25_000_000,
        )
        .is_err());
        assert!(require_session_token_delegate(
            COption::Some(Pubkey::new_unique()),
            25_000_000,
            session_signer,
            25_000_000,
        )
        .is_err());
        assert!(require_session_token_delegate(
            COption::Some(session_signer),
            24_999_999,
            session_signer,
            25_000_000,
        )
        .is_err());
    }
}
