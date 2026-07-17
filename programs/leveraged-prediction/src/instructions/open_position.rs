use super::*;

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
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let sample = read_oracle_price(&ctx.accounts.price_update.to_account_info(), &clock)?;
    require!(
        sample.price >= min_entry_price && sample.price <= max_entry_price,
        ErrorCode::SlippageExceeded
    );

    let pool_before = ctx.accounts.pool_token_account.amount;
    let epoch_equity = if ctx.accounts.market.active_positions == 0 {
        bounded_risk_epoch_equity(pool_before, MAX_INITIAL_LIQUIDITY)
    } else {
        ctx.accounts.market.risk_epoch_equity
    };
    require_open_liquidity(
        ctx.accounts.market.total_shares,
        epoch_equity,
        pool_before,
        MIN_INITIAL_LIQUIDITY,
    )?;
    let user_open_collateral =
        ctx.accounts
            .user_position
            .positions
            .iter()
            .try_fold(0_u64, |sum, position| {
                sum.checked_add(u64::from(position.collateral))
                    .ok_or(ErrorCode::MathOverflow)
            })?;
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
    let scheduled_metas = [
        SchedMeta::readonly(ctx.accounts.user.key().to_bytes()),
        SchedMeta::writable(ctx.accounts.market.key().to_bytes()),
        SchedMeta::writable(ctx.accounts.user_position.key().to_bytes()),
        SchedMeta::writable(ctx.accounts.pool_token_account.key().to_bytes()),
        SchedMeta::writable(ctx.accounts.user_token_account.key().to_bytes()),
        SchedMeta::readonly(ctx.accounts.derived_fee_authority.key().to_bytes()),
        SchedMeta::writable(ctx.accounts.fee_token_account.key().to_bytes()),
        SchedMeta::readonly(ctx.accounts.collateral_mint.key().to_bytes()),
        SchedMeta::readonly(ctx.accounts.price_update.key().to_bytes()),
        SchedMeta::readonly(ctx.accounts.token_program.key().to_bytes()),
        SchedMeta::readonly(Instructions::id().to_bytes()),
    ];
    let scheduled = [ScheduledIx {
        program_id: crate::ID.to_bytes(),
        metas: &scheduled_metas,
        data: &scheduled_data,
    }];
    let task_args = HydraCreateArgs {
        seed: task_seed,
        authority: [0; 32],
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
    let materialized_task_data_len =
        crank_account_size(region_len_for(scheduled_metas.len(), scheduled_data.len()));
    let task_rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
        u32::try_from(materialized_task_data_len).map_err(|_| error!(ErrorCode::MathOverflow))?,
    );
    let reward_budget = HYDRA_REMAINING_ATTEMPTS
        .checked_add(1)
        .and_then(|attempts| attempts.checked_mul(HYDRA_CRANKER_REWARD))
        .ok_or(ErrorCode::MathOverflow)?;
    let task_cost = task_rent
        .checked_add(reward_budget)
        .ok_or(ErrorCode::MathOverflow)?;
    let sponsor_reserve = task_cost
        .checked_mul(u64::from(MAX_MARKET_FINANCIALLY_ACTIVE_POSITIONS))
        .ok_or(ErrorCode::MathOverflow)?;
    let market_info = ctx.accounts.market.to_account_info();
    let market_rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
    let required_market_lamports = market_rent_floor
        .checked_add(task_cost)
        .and_then(|value| value.checked_add(sponsor_reserve))
        .ok_or(ErrorCode::MathOverflow)?;
    transfer_lamports(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            LamportsTransfer {
                from: ctx.accounts.user.to_account_info(),
                to: market_info.clone(),
            },
        ),
        task_cost,
    )?;
    require!(
        market_info.lamports() >= required_market_lamports,
        ErrorCode::InsufficientHydraSponsorLamports
    );
    let market_bump = [ctx.accounts.market.bump];
    let market_mint = ctx.accounts.market.collateral_mint;
    let market_seeds: &[&[u8]] = &[MARKET_SEED, market_mint.as_ref(), &market_bump];
    hydra_cpi::create(
        &market_info,
        &ctx.accounts.hydra_crank.to_account_info(),
        &ctx.accounts.ephemeral_vault.to_account_info(),
        &ctx.accounts.magic_program.to_account_info(),
        &task_args,
        &[market_seeds],
    )
    .map_err(|_| error!(ErrorCode::HydraTaskCreationFailed))?;
    {
        let crank_info = ctx.accounts.hydra_crank.to_account_info();
        let mut market_lamports = market_info.try_borrow_mut_lamports()?;
        let mut crank_lamports = crank_info.try_borrow_mut_lamports()?;
        **market_lamports = market_lamports
            .checked_sub(reward_budget)
            .ok_or(ErrorCode::MathOverflow)?;
        **crank_lamports = crank_lamports
            .checked_add(reward_budget)
            .ok_or(ErrorCode::MathOverflow)?;
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.pool_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        collateral,
    )?;
    let expires_at = now
        .checked_add(POSITION_DURATION_SECONDS)
        .ok_or(ErrorCode::MathOverflow)?;
    let (compact_collateral, compact_expires_at) = compact_position_values(collateral, expires_at)?;
    ctx.accounts.user_position.positions.push(CompactPosition {
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

#[derive(Accounts)]
#[instruction(nonce: u32, task_salt: [u8; 32])]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [USER_POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub user_position: Box<Account<'info, UserPosition>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical zero-data PDA used by the scheduled settlement instruction.
    #[account(seeds = [FEE_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub derived_fee_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Canonical address and owner are constrained here; payload is parsed in the handler.
    #[account(address = ORACLE_ACCOUNT, owner = ORACLE_PROGRAM_ID)]
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Address is derived from the Market, user, position nonce, and task salt.
    #[account(mut, address = hydra_crank_address(market.key(), user.key(), nonce, task_salt) @ ErrorCode::InvalidHydraCrank)]
    pub hydra_crank: UncheckedAccount<'info>,
    /// CHECK: Canonical Hydra ER program; explicit meta lets the ER clone it before CPI.
    #[account(address = HYDRA_EPHEMERAL_PROGRAM_ID, executable)]
    pub hydra_program: UncheckedAccount<'info>,
    /// CHECK: Canonical MagicBlock ephemeral-account rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Canonical MagicBlock Magic program used by Hydra creation.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
