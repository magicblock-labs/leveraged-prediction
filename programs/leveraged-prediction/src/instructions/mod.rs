use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::SysvarId;
use anchor_lang::system_program::{transfer as transfer_lamports, Transfer as LamportsTransfer};
use anchor_lang::InstructionData;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use hydra_api::{
    consts::ephemeral::CRANKER_REWARD as HYDRA_CRANKER_REWARD,
    cpi::ephemeral::native as hydra_cpi,
    instruction::{
        ephemeral::PROGRAM_ID as HYDRA_EPHEMERAL_PROGRAM_ID, CreateArgs as HydraCreateArgs,
        SchedMeta, ScheduledIx,
    },
    state::{crank_account_size, region_len_for},
};
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::error::ErrorCode;
use crate::math::{
    assets_for_shares, bounded_risk_epoch_equity, calculate_settlement, compact_position_values,
    require_collateral_bounds, require_deposit_capacity, require_open_liquidity,
    require_post_open_solvency, require_user_open_collateral_capacity,
    require_valid_withdrawal_remainder, shares_for_deposit,
};
use crate::state::{CompactPosition, Direction, Market, MarketMode, ProtocolConfig, UserPosition};
use crate::{
    hydra_crank_address, hydra_task_seed, LiquidityDeposited, MarketModeChanged,
    ProtocolFeesWithdrawn, SettleOutcome, SettlePositionResult, WithdrawalCancelled,
    WithdrawalExecuted, WithdrawalRequested, COLLATERAL_DECIMALS, CONFIG_SEED, FEE_AUTHORITY_SEED,
    HYDRA_COMPUTE_UNIT_LIMIT, HYDRA_FIRST_ATTEMPT_DELAY_SLOTS, HYDRA_INTERVAL_SLOTS,
    HYDRA_REMAINING_ATTEMPTS, LEVERAGE, MARKET_SEED, MAX_INITIAL_LIQUIDITY,
    MAX_MARKET_FINANCIALLY_ACTIVE_POSITIONS, MAX_POSITION_COLLATERAL, MIN_INITIAL_LIQUIDITY,
    MIN_POSITION_COLLATERAL, ORACLE_ACCOUNT, ORACLE_EXPONENT, ORACLE_FEED_ID,
    ORACLE_MAX_AGE_SECONDS, ORACLE_MAX_CONFIDENCE_BPS, ORACLE_PROGRAM_ID,
    POSITION_DURATION_SECONDS, PROFIT_FEE_BPS, PROTOCOL_FEE_SHARE_BPS, SAFETY_BUFFER_BPS,
    SETTLEMENT_BUFFER_SECONDS, USER_OPEN_COLLATERAL_BPS, USER_POSITION_SEED,
};

pub mod cancel_withdrawal;
pub mod delegate_market;
pub mod deposit_liquidity;
pub mod execute_withdrawal;
pub mod initialize_market;
pub mod initialize_protocol_config;
pub mod initialize_user_position;
pub mod open_position;
pub mod request_withdrawal;
pub mod set_market_mode;
pub mod settle_position;
pub mod withdraw_protocol_fees;

pub use delegate_market::DelegateMarket;
pub use deposit_liquidity::DepositLiquidity;
pub use execute_withdrawal::ExecuteWithdrawal;
pub use initialize_market::InitializeMarket;
pub use initialize_protocol_config::InitializeProtocolConfig;
pub use initialize_user_position::InitializeUserPosition;
pub use open_position::OpenPosition;
pub use request_withdrawal::ManageWithdrawal;
pub use set_market_mode::AdminMarket;
pub use settle_position::SettlePosition;
pub use withdraw_protocol_fees::WithdrawProtocolFees;

pub(crate) fn market_transfer<'info>(
    market: &Account<'info, Market>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let mint = market.collateral_mint;
    let bump = [market.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, mint.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            SplTransfer {
                from,
                to,
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

pub(crate) fn read_oracle_price(account: &AccountInfo<'_>, clock: &Clock) -> Result<Price> {
    let data = account.try_borrow_data()?;
    let update = PriceUpdateV2::try_deserialize_unchecked(&mut data.as_ref())?;
    require!(update.posted_slot > 0, ErrorCode::InvalidOraclePrice);

    let price = update.get_price_no_older_than(
        clock,
        u64::from(ORACLE_MAX_AGE_SECONDS),
        &ORACLE_FEED_ID,
    )?;
    require!(
        price.price > 0 && price.publish_time <= clock.unix_timestamp,
        ErrorCode::InvalidOraclePrice
    );
    require!(
        price.exponent == ORACLE_EXPONENT,
        ErrorCode::OracleExponentMismatch
    );
    let confidence_scaled = u128::from(price.conf)
        .checked_mul(10_000)
        .ok_or(ErrorCode::MathOverflow)?;
    let maximum_confidence = u128::from(price.price.unsigned_abs())
        .checked_mul(u128::from(ORACLE_MAX_CONFIDENCE_BPS))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        confidence_scaled <= maximum_confidence,
        ErrorCode::InvalidOraclePrice
    );
    Ok(price)
}
