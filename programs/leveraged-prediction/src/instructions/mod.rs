use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as transfer_lamports, Transfer as LamportsTransfer};
use anchor_lang::InstructionData;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2, VerificationLevel};

use crate::error::ErrorCode;
use crate::math::{
    assets_for_shares, bounded_risk_epoch_equity, calculate_settlement, compact_position_values,
    require_collateral_bounds, require_deposit_capacity, require_open_liquidity,
    require_post_open_solvency, require_user_open_collateral_capacity,
    require_valid_withdrawal_remainder, shares_for_deposit,
};
use crate::state::{
    CompactPosition, Direction, Market, MarketMode, ProtocolConfig, UserLiquidity, UserPositions,
};
use crate::{
    settlement_crank_signer, settlement_task_id, FallbackPayoutClaimed, LiquidityDeposited,
    MarketModeChanged, PositionClosed, PositionCreated, PositionOutcome, ProtocolFeesWithdrawn,
    WithdrawalCancelled, WithdrawalExecuted, WithdrawalRequested, COLLATERAL_DECIMALS, CONFIG_SEED,
    FEE_AUTHORITY_SEED, LEVERAGE, MARKET_SEED, MAX_MARKET_EQUITY, MAX_POSITION_COLLATERAL,
    MIN_MARKET_EQUITY, MIN_POSITION_COLLATERAL, ORACLE_EXPONENT, ORACLE_MAX_AGE_SECONDS,
    ORACLE_MAX_CONFIDENCE_BPS, ORACLE_PROGRAM_ID, POSITION_DURATION_SECONDS, PROFIT_FEE_BPS,
    PROTOCOL_FEE_SHARE_BPS, SAFETY_BUFFER_BPS, SETTLEMENT_BUFFER_SECONDS,
    SETTLEMENT_TASK_INTERVAL_MILLIS, SETTLEMENT_TASK_ITERATIONS, USER_LIQUIDITY_SEED,
    USER_OPEN_COLLATERAL_BPS, USER_POSITIONS_SEED,
};

const DELEGATED_STATE_COMMIT_FREQUENCY_MS: u32 = 10_000;

pub mod cancel_withdrawal;
pub mod claim_fallback_payout;
pub mod delegate_market;
pub mod delegate_user_liquidity;
pub mod delegate_user_positions;
pub mod deposit_liquidity;
pub mod execute_withdrawal;
pub mod initialize_market;
pub mod initialize_protocol_config;
pub mod initialize_user_liquidity;
pub mod initialize_user_positions;
pub mod open_position;
pub mod request_withdrawal;
pub mod set_market_mode;
pub mod settle_position;
pub mod undelegate_user_liquidity;
pub mod withdraw_protocol_fees;

pub use claim_fallback_payout::ClaimFallbackPayout;
pub use delegate_market::DelegateMarket;
pub use delegate_user_liquidity::DelegateUserLiquidity;
pub use delegate_user_positions::DelegateUserPositions;
pub use deposit_liquidity::DepositLiquidity;
pub use execute_withdrawal::ExecuteWithdrawal;
pub use initialize_market::InitializeMarket;
pub use initialize_protocol_config::InitializeProtocolConfig;
pub use initialize_user_liquidity::InitializeUserLiquidity;
pub use initialize_user_positions::InitializeUserPositions;
pub use open_position::OpenPosition;
pub use request_withdrawal::ManageWithdrawal;
pub use set_market_mode::AdminMarket;
pub use settle_position::SettlePosition;
pub use undelegate_user_liquidity::UndelegateUserLiquidity;
pub use withdraw_protocol_fees::WithdrawProtocolFees;

pub(crate) fn delegated_state_config() -> DelegateConfig {
    DelegateConfig {
        commit_frequency_ms: DELEGATED_STATE_COMMIT_FREQUENCY_MS,
        validator: None,
    }
}

pub(crate) fn is_usable_payout_destination(account: &AccountInfo<'_>, mint: Pubkey) -> bool {
    if account.owner != &token::ID {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    let Ok(account) = TokenAccount::try_deserialize_unchecked(&mut data.as_ref()) else {
        return false;
    };
    account.mint == mint
        && account.state == anchor_spl::token::spl_token::state::AccountState::Initialized
}

#[cfg(test)]
mod delegation_tests {
    use super::*;

    #[test]
    fn delegated_state_has_bounded_commits_and_default_routing() {
        let config = delegated_state_config();
        assert_eq!(config.commit_frequency_ms, 10_000);
        assert_eq!(config.validator, None);
    }
}

#[cfg(test)]
mod payout_destination_tests {
    use super::*;
    use anchor_lang::solana_program::{program_option::COption, program_pack::Pack};
    use anchor_spl::token::spl_token::state::{Account as SplTokenAccount, AccountState};

    #[test]
    fn payout_destination_requires_an_initialized_account_for_the_collateral_mint() {
        let key = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let mut lamports = 0;
        let mut data = vec![0_u8; SplTokenAccount::LEN];
        SplTokenAccount::pack(
            SplTokenAccount {
                mint,
                owner: Pubkey::new_unique(),
                amount: 0,
                delegate: COption::None,
                state: AccountState::Initialized,
                is_native: COption::None,
                delegated_amount: 0,
                close_authority: COption::None,
            },
            &mut data,
        )
        .unwrap();
        let token_program = token::ID;
        let account = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut data,
            &token_program,
            false,
        );

        assert!(is_usable_payout_destination(&account, mint));
        assert!(!is_usable_payout_destination(
            &account,
            Pubkey::new_unique()
        ));
    }
}

pub(crate) fn market_transfer<'info>(
    market: &Account<'info, Market>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let market_id = market.market_id.to_le_bytes();
    let bump = [market.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, market_id.as_ref(), &bump];
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

pub(crate) fn read_oracle_price(
    account: &AccountInfo<'_>,
    clock: &Clock,
    expected_feed_id: &[u8; 32],
) -> Result<Option<Price>> {
    require_keys_eq!(
        *account.owner,
        ORACLE_PROGRAM_ID,
        ErrorCode::InvalidOraclePrice
    );
    let data = account.try_borrow_data()?;
    let update = PriceUpdateV2::try_deserialize_unchecked(&mut data.as_ref())?;
    validate_oracle_price(&update, clock, expected_feed_id)
}

fn validate_oracle_price(
    update: &PriceUpdateV2,
    clock: &Clock,
    expected_feed_id: &[u8; 32],
) -> Result<Option<Price>> {
    require!(
        update.price_message.feed_id == *expected_feed_id,
        ErrorCode::InvalidOraclePrice
    );
    let price = update
        .get_price_unchecked(expected_feed_id)
        .map_err(|_| error!(ErrorCode::InvalidOraclePrice))?;
    require!(
        price.exponent == ORACLE_EXPONENT,
        ErrorCode::OracleExponentMismatch
    );

    let is_stale = price
        .publish_time
        .checked_add(i64::from(ORACLE_MAX_AGE_SECONDS))
        .map(|fresh_until| fresh_until < clock.unix_timestamp)
        .unwrap_or(true);
    if update.posted_slot == 0
        || !update.verification_level.gte(VerificationLevel::Full)
        || is_stale
        || price.publish_time > clock.unix_timestamp
        || price.price <= 0
    {
        return Ok(None);
    }

    let confidence_scaled = u128::from(price.conf)
        .checked_mul(10_000)
        .ok_or(ErrorCode::MathOverflow)?;
    let maximum_confidence = u128::from(price.price.unsigned_abs())
        .checked_mul(u128::from(ORACLE_MAX_CONFIDENCE_BPS))
        .ok_or(ErrorCode::MathOverflow)?;
    if confidence_scaled > maximum_confidence {
        return Ok(None);
    }
    Ok(Some(price))
}

#[cfg(test)]
mod oracle_tests {
    use super::*;
    use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, VerificationLevel};

    fn update(feed_id: [u8; 32]) -> PriceUpdateV2 {
        PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id,
                price: 100_000_000,
                conf: 1,
                exponent: ORACLE_EXPONENT,
                publish_time: 100,
                prev_publish_time: 99,
                ema_price: 100_000_000,
                ema_conf: 1,
            },
            posted_slot: 1,
        }
    }

    fn clock() -> Clock {
        Clock {
            unix_timestamp: 100,
            ..Clock::default()
        }
    }

    #[test]
    fn oracle_payload_for_a_different_market_feed_is_rejected() {
        let configured_feed = [1; 32];
        let update = update([2; 32]);

        assert!(validate_oracle_price(&update, &clock(), &configured_feed).is_err());
    }

    #[test]
    fn oracle_payload_with_wrong_exponent_is_rejected() {
        let feed = [1; 32];
        let mut update = update(feed);
        update.price_message.exponent = ORACLE_EXPONENT - 1;

        assert!(validate_oracle_price(&update, &clock(), &feed).is_err());
    }

    #[test]
    fn unposted_oracle_payload_is_not_ready() {
        let feed = [1; 32];
        let mut update = update(feed);
        update.posted_slot = 0;

        assert_eq!(
            validate_oracle_price(&update, &clock(), &feed).unwrap(),
            None
        );
    }

    #[test]
    fn partially_verified_oracle_payload_is_not_ready() {
        let feed = [1; 32];
        let mut update = update(feed);
        update.verification_level = VerificationLevel::Partial { num_signatures: 10 };

        assert_eq!(
            validate_oracle_price(&update, &clock(), &feed).unwrap(),
            None
        );
    }

    #[test]
    fn stale_oracle_payload_is_not_ready() {
        let feed = [1; 32];
        let mut update = update(feed);
        update.price_message.publish_time = 100 - i64::from(ORACLE_MAX_AGE_SECONDS) - 1;

        assert_eq!(
            validate_oracle_price(&update, &clock(), &feed).unwrap(),
            None
        );
    }
}
