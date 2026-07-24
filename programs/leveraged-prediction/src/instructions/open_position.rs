use super::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
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
    require!(task_salt != [0_u8; 32], ErrorCode::InvalidSettlementTask);
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

    let scheduled_instruction = settlement_instruction(
        crate::accounts::SettlePosition {
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
            crank_signer: ctx.accounts.crank_signer.key(),
        },
        nonce,
        task_salt,
    )?;
    let settlement_accounts = [
        ctx.accounts.user.to_account_info(),
        ctx.accounts.protocol_config.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.user_positions.to_account_info(),
        ctx.accounts.pool_token_account.to_account_info(),
        ctx.accounts.user_token_account.to_account_info(),
        ctx.accounts.payout_escrow_token_account.to_account_info(),
        ctx.accounts.derived_fee_authority.to_account_info(),
        ctx.accounts.fee_token_account.to_account_info(),
        ctx.accounts.collateral_mint.to_account_info(),
        ctx.accounts.price_update.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.crank_signer.to_account_info(),
    ];
    let market_id = ctx.accounts.market.market_id.to_le_bytes();
    let market_bump = [ctx.accounts.market.bump];
    let market_signer_seeds: &[&[u8]] = &[MARKET_SEED, market_id.as_ref(), &market_bump];
    let schedule_data =
        bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id: settlement_task_id(
                ctx.accounts.market.key(),
                ctx.accounts.user.key(),
                nonce,
                task_salt,
            ),
            execution_interval_millis: SETTLEMENT_TASK_INTERVAL_MILLIS,
            iterations: SETTLEMENT_TASK_ITERATIONS,
            instructions: vec![scheduled_instruction],
        }))
        .map_err(|_| error!(ErrorCode::SettlementTaskCreationFailed))?;
    let mut schedule_metas = Vec::with_capacity(1 + settlement_accounts.len());
    schedule_metas.push(AccountMeta::new(ctx.accounts.market.key(), true));
    schedule_metas.extend(settlement_accounts.iter().map(|account| AccountMeta {
        pubkey: account.key(),
        is_signer: account.is_signer,
        is_writable: account.is_writable,
    }));
    let schedule_instruction =
        Instruction::new_with_bytes(MAGIC_PROGRAM_ID, &schedule_data, schedule_metas);
    let mut schedule_accounts = Vec::with_capacity(1 + settlement_accounts.len());
    schedule_accounts.push(ctx.accounts.market.to_account_info());
    schedule_accounts.extend(settlement_accounts);
    invoke_signed(
        &schedule_instruction,
        &schedule_accounts,
        &[market_signer_seeds],
    )
    .map_err(|_| error!(ErrorCode::SettlementTaskCreationFailed))?;

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
    emit!(PositionCreated {
        market_id: ctx.accounts.market.market_id,
        position_id: nonce,
        user: ctx.accounts.user.key(),
        entry_price: sample.price,
        collateral: compact_collateral,
        direction,
        expires_at: compact_expires_at,
    });
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

fn settlement_instruction(
    accounts: crate::accounts::SettlePosition,
    nonce: u32,
    task_salt: [u8; 32],
) -> Result<Instruction> {
    let crank_signer = accounts.crank_signer;
    let metas = accounts.to_account_metas(None);
    require!(
        metas
            .iter()
            .filter(|meta| meta.is_signer)
            .all(|meta| meta.pubkey == crank_signer && !meta.is_writable),
        ErrorCode::InvalidSettlementTask
    );
    Ok(Instruction {
        program_id: crate::ID,
        accounts: metas,
        data: crate::instruction::SettlePosition { nonce, task_salt }.data(),
    })
}

#[derive(Accounts, SessionV2)]
#[instruction(nonce: u32, task_salt: [u8; 32])]
pub struct OpenPosition<'info> {
    /// CHECK: Wallet authority bound to UserPositions, the session token, and the token account.
    pub user: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
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
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = derived_fee_authority)]
    pub fee_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ ErrorCode::InvalidTokenOwner,
        constraint = user_token_account.mint == collateral_mint.key() @ ErrorCode::TokenMintMismatch
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = user_positions)]
    pub payout_escrow_token_account: Box<Account<'info, TokenAccount>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Canonical address is constrained here; payload and owner are parsed in the handler.
    #[account(address = market.oracle)]
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Canonical signer added by the native scheduler when it executes the task.
    #[account(
        address = settlement_crank_signer(market.key()) @ ErrorCode::InvalidSettlementTask
    )]
    pub crank_signer: UncheckedAccount<'info>,
    /// CHECK: Canonical native MagicBlock program on every Ephemeral Rollup.
    #[account(address = MAGIC_PROGRAM_ID, executable)]
    pub magic_program: UncheckedAccount<'info>,
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
            crank_signer: keys[12],
        };
        let expected = generated.to_account_metas(None);
        assert_eq!(
            expected
                .iter()
                .filter(|meta| meta.is_signer)
                .map(|meta| meta.pubkey)
                .collect::<Vec<_>>(),
            vec![keys[12]]
        );

        let actual = settlement_instruction(generated, 7, [1_u8; 32]).unwrap();
        assert_eq!(actual.accounts, expected);
        assert_eq!(
            actual.data,
            crate::instruction::SettlePosition {
                nonce: 7,
                task_salt: [1_u8; 32]
            }
            .data()
        );
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
