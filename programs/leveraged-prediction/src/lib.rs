use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
use session_keys::{session_auth_or, SessionError};
use solana_sha256_hasher::hashv;

pub mod error;
pub mod instructions;
pub mod math;
pub mod state;

use error::ErrorCode;
use instructions::*;
use state::{Direction, MarketMode};

pub(crate) use instructions::claim_fallback_payout::__client_accounts_claim_fallback_payout;
pub(crate) use instructions::delegate_market::__client_accounts_delegate_market;
pub(crate) use instructions::delegate_user_liquidity::__client_accounts_delegate_user_liquidity;
pub(crate) use instructions::delegate_user_positions::__client_accounts_delegate_user_positions;
pub(crate) use instructions::deposit_liquidity::__client_accounts_deposit_liquidity;
pub(crate) use instructions::execute_withdrawal::__client_accounts_execute_withdrawal;
pub(crate) use instructions::initialize_market::__client_accounts_initialize_market;
pub(crate) use instructions::initialize_protocol_config::__client_accounts_initialize_protocol_config;
pub(crate) use instructions::initialize_user_liquidity::__client_accounts_initialize_user_liquidity;
pub(crate) use instructions::initialize_user_positions::__client_accounts_initialize_user_positions;
pub(crate) use instructions::open_position::__client_accounts_open_position;
pub(crate) use instructions::request_withdrawal::__client_accounts_manage_withdrawal;
pub(crate) use instructions::set_market_mode::__client_accounts_admin_market;
pub(crate) use instructions::settle_position::__client_accounts_settle_position;
pub(crate) use instructions::undelegate_user_liquidity::__client_accounts_undelegate_user_liquidity;
pub(crate) use instructions::withdraw_protocol_fees::__client_accounts_withdraw_protocol_fees;

declare_id!("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");

pub const CONFIG_SEED: &[u8] = b"protocol_config";
pub const MARKET_SEED: &[u8] = b"market";
pub const USER_POSITIONS_SEED: &[u8] = b"user_positions";
pub const USER_LIQUIDITY_SEED: &[u8] = b"user_liquidity";
pub const FEE_AUTHORITY_SEED: &[u8] = b"fee_authority";
pub const ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
pub const ORACLE_EXPONENT: i32 = 8;
pub const COLLATERAL_DECIMALS: u8 = 6;
pub const LEVERAGE: u16 = 1_000;
pub const MAX_GROSS_PROFIT_MULTIPLIER: u16 = 5;
pub const POSITION_DURATION_SECONDS: i64 = 10;
pub const SETTLEMENT_BUFFER_SECONDS: i64 = 10;
pub const MAX_MARKET_FINANCIALLY_ACTIVE_POSITIONS: u32 = 8;
pub const MIN_POSITION_COLLATERAL: u64 = 1_000_000;
pub const MAX_POSITION_COLLATERAL: u64 = 1_000_000_000;
pub const MIN_MARKET_EQUITY: u64 = 100_000_000_000;
pub const MAX_MARKET_EQUITY: u64 = 100_000_000_000_000;
pub const USER_OPEN_COLLATERAL_BPS: u16 = 100;
pub const SAFETY_BUFFER_BPS: u16 = 1_000;
pub const PROFIT_FEE_BPS: u16 = 1_000;
pub const PROTOCOL_FEE_SHARE_BPS: u16 = 2_000;
pub const ORACLE_MAX_AGE_SECONDS: u16 = 2;
pub const ORACLE_MAX_CONFIDENCE_BPS: u16 = 1;
pub const SETTLEMENT_TASK_INTERVAL_MILLIS: i64 = 1_000;
pub const SETTLEMENT_TASK_ITERATIONS: i64 = 25;

pub fn require_market_financial_capacity(active_positions: u32) -> Result<()> {
    require!(
        active_positions < MAX_MARKET_FINANCIALLY_ACTIVE_POSITIONS,
        ErrorCode::RiskLimitExceeded
    );
    Ok(())
}

#[event]
pub struct PositionCreated {
    pub market_id: u16,
    pub position_id: u32,
    pub user: Pubkey,
    pub entry_price: i64,
    pub collateral: u32,
    pub direction: Direction,
    pub expires_at: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PositionOutcome {
    Won,
    Lost,
    Breakeven,
    Refunded,
}

#[event]
pub struct PositionClosed {
    pub market_id: u16,
    pub position_id: u32,
    pub outcome: PositionOutcome,
    pub payout_amount: u64,
    pub lp_fee_amount: u64,
    pub platform_fee_amount: u64,
}

#[event]
pub struct MarketModeChanged {
    pub market_id: u16,
    pub mode: MarketMode,
}

#[event]
pub struct LiquidityDeposited {
    pub market_id: u16,
    pub user: Pubkey,
    pub assets: u64,
    pub shares: u128,
}

#[event]
pub struct WithdrawalRequested {
    pub market_id: u16,
    pub user: Pubkey,
    pub shares: u128,
    pub min_assets_out: u64,
}

#[event]
pub struct WithdrawalCancelled {
    pub market_id: u16,
    pub user: Pubkey,
    pub shares: u128,
}

#[event]
pub struct WithdrawalExecuted {
    pub market_id: u16,
    pub user: Pubkey,
    pub shares: u128,
    pub assets: u64,
}

#[event]
pub struct ProtocolFeesWithdrawn {
    pub market_id: u16,
    pub destination: Pubkey,
    pub assets: u64,
}

#[event]
pub struct FallbackPayoutClaimed {
    pub user: Pubkey,
    pub destination: Pubkey,
    pub assets: u64,
}

pub fn settlement_task_id(market: Pubkey, user: Pubkey, nonce: u32, task_salt: [u8; 32]) -> i64 {
    let digest = hashv(&[
        b"leveraged_prediction_position",
        market.as_ref(),
        user.as_ref(),
        &nonce.to_le_bytes(),
        &task_salt,
    ])
    .to_bytes();
    let mut id_bytes = [0_u8; 8];
    id_bytes.copy_from_slice(&digest[..8]);
    let id = u64::from_le_bytes(id_bytes) & i64::MAX as u64;
    i64::try_from(id.max(1)).expect("positive 63-bit value always fits in i64")
}

pub fn settlement_crank_signer(task_authority: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"crank-executor", task_authority.as_ref()],
        &magicblock_magic_program_api::CRANK_PROGRAM_ID,
    )
    .0
}

#[ephemeral]
#[program]
pub mod leveraged_prediction {
    use super::*;

    pub fn initialize_protocol_config(ctx: Context<InitializeProtocolConfig>) -> Result<()> {
        instructions::initialize_protocol_config::handler(ctx)
    }

    pub fn claim_fallback_payout(ctx: Context<ClaimFallbackPayout>) -> Result<()> {
        instructions::claim_fallback_payout::handler(ctx)
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u16,
        oracle: Pubkey,
        oracle_feed_id: [u8; 32],
        sponsor_lamports: u64,
    ) -> Result<()> {
        instructions::initialize_market::handler(
            ctx,
            market_id,
            oracle,
            oracle_feed_id,
            sponsor_lamports,
        )
    }

    pub fn set_market_mode(ctx: Context<AdminMarket>, mode: MarketMode) -> Result<()> {
        instructions::set_market_mode::handler(ctx, mode)
    }

    pub fn delegate_market(
        ctx: Context<DelegateMarket>,
        market_id: u16,
        validator: Pubkey,
    ) -> Result<()> {
        instructions::delegate_market::handler(ctx, market_id, validator)
    }

    pub fn initialize_user_positions(ctx: Context<InitializeUserPositions>) -> Result<()> {
        instructions::initialize_user_positions::handler(ctx)
    }

    pub fn initialize_user_liquidity(ctx: Context<InitializeUserLiquidity>) -> Result<()> {
        instructions::initialize_user_liquidity::handler(ctx)
    }

    pub fn delegate_user_positions(
        ctx: Context<DelegateUserPositions>,
        validator: Pubkey,
    ) -> Result<()> {
        instructions::delegate_user_positions::handler(ctx, validator)
    }

    pub fn delegate_user_liquidity(
        ctx: Context<DelegateUserLiquidity>,
        validator: Pubkey,
    ) -> Result<()> {
        instructions::delegate_user_liquidity::handler(ctx, validator)
    }

    pub fn undelegate_user_liquidity(ctx: Context<UndelegateUserLiquidity>) -> Result<()> {
        instructions::undelegate_user_liquidity::handler(ctx)
    }

    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount: u64,
        min_shares_out: u128,
    ) -> Result<()> {
        instructions::deposit_liquidity::handler(ctx, amount, min_shares_out)
    }

    pub fn request_withdrawal(
        ctx: Context<ManageWithdrawal>,
        shares: u128,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::request_withdrawal::handler(ctx, shares, min_assets_out)
    }

    pub fn cancel_withdrawal(ctx: Context<ManageWithdrawal>) -> Result<()> {
        instructions::cancel_withdrawal::handler(ctx)
    }

    pub fn execute_withdrawal(ctx: Context<ExecuteWithdrawal>) -> Result<()> {
        instructions::execute_withdrawal::handler(ctx)
    }

    #[session_auth_or(false, SessionError::InvalidToken)]
    pub fn open_position(
        ctx: Context<OpenPosition>,
        nonce: u32,
        task_salt: [u8; 32],
        direction: Direction,
        collateral: u64,
        min_entry_price: i64,
        max_entry_price: i64,
    ) -> Result<()> {
        instructions::open_position::handler(
            ctx,
            nonce,
            task_salt,
            direction,
            collateral,
            min_entry_price,
            max_entry_price,
        )
    }

    pub fn settle_position(
        ctx: Context<SettlePosition>,
        nonce: u32,
        task_salt: [u8; 32],
    ) -> Result<()> {
        instructions::settle_position::handler(ctx, nonce, task_salt)
    }

    pub fn withdraw_protocol_fees(ctx: Context<WithdrawProtocolFees>, amount: u64) -> Result<()> {
        instructions::withdraw_protocol_fees::handler(ctx, amount)
    }
}

#[cfg(test)]
mod address_tests {
    use super::*;

    fn serialized<T: AnchorSerialize>(value: &T) -> Vec<u8> {
        let mut bytes = Vec::new();
        value.serialize(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn position_task_salt_changes_the_scheduler_task_id() {
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        assert_ne!(
            settlement_task_id(market, user, 1, [1; 32]),
            settlement_task_id(market, user, 1, [2; 32])
        );
    }

    #[test]
    fn scheduler_task_ids_are_positive() {
        let market = pubkey!("6ME7jFHJkk27zAM7hz2A3V1Y4EeTkcjyZxnekQLtn8V1");
        let user = pubkey!("11111111111111111111111111111112");
        assert!(settlement_task_id(market, user, 7, [1; 32]) > 0);
        assert_eq!(
            settlement_crank_signer(market),
            pubkey!("BLfDLg2Sv4wrbRaNb6sZv6wWvrg1BpaDArW5FaoricW1")
        );
    }

    #[test]
    fn protocol_config_is_global_and_market_ids_are_isolated() {
        let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID);
        let (same_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID);
        assert_eq!(config, same_config);

        let (market_zero, _) =
            Pubkey::find_program_address(&[MARKET_SEED, &0_u16.to_le_bytes()], &crate::ID);
        let (market_one, _) =
            Pubkey::find_program_address(&[MARKET_SEED, &1_u16.to_le_bytes()], &crate::ID);
        assert_ne!(market_zero, market_one);
    }

    #[test]
    fn user_state_pdas_are_user_scoped_and_split_by_workload() {
        let first_user = Pubkey::new_unique();
        let second_user = Pubkey::new_unique();
        let (first_positions, _) =
            Pubkey::find_program_address(&[USER_POSITIONS_SEED, first_user.as_ref()], &crate::ID);
        let (first_liquidity, _) =
            Pubkey::find_program_address(&[USER_LIQUIDITY_SEED, first_user.as_ref()], &crate::ID);
        let (second_positions, _) =
            Pubkey::find_program_address(&[USER_POSITIONS_SEED, second_user.as_ref()], &crate::ID);

        assert_ne!(first_positions, first_liquidity);
        assert_ne!(first_positions, second_positions);
    }

    #[test]
    fn compact_position_event_payload_sizes_and_enum_order_are_locked() {
        let created = PositionCreated {
            market_id: 1,
            position_id: 7,
            user: Pubkey::new_unique(),
            entry_price: 100_000,
            collateral: 1_000_000,
            direction: Direction::Up,
            expires_at: 42,
        };
        let closed = PositionClosed {
            market_id: 1,
            position_id: 7,
            outcome: PositionOutcome::Won,
            payout_amount: 1_900_000,
            lp_fee_amount: 80_000,
            platform_fee_amount: 20_000,
        };

        assert_eq!(serialized(&created).len(), 55);
        assert_eq!(serialized(&closed).len(), 31);
        assert_eq!(serialized(&PositionOutcome::Won), [0]);
        assert_eq!(serialized(&PositionOutcome::Lost), [1]);
        assert_eq!(serialized(&PositionOutcome::Breakeven), [2]);
        assert_eq!(serialized(&PositionOutcome::Refunded), [3]);
    }

    #[test]
    fn user_state_initialization_and_delegation_require_only_the_user_signer() {
        let keys = (0..16).map(|_| Pubkey::new_unique()).collect::<Vec<_>>();
        let initialize_positions = crate::accounts::InitializeUserPositions {
            user: keys[0],
            user_positions: keys[1],
            system_program: keys[2],
        }
        .to_account_metas(None);
        let initialize_liquidity = crate::accounts::InitializeUserLiquidity {
            user: keys[0],
            user_liquidity: keys[3],
            system_program: keys[2],
        }
        .to_account_metas(None);
        let delegate_positions = crate::accounts::DelegateUserPositions {
            user: keys[0],
            buffer_user_positions: keys[4],
            delegation_record_user_positions: keys[5],
            delegation_metadata_user_positions: keys[6],
            user_positions: keys[1],
            owner_program: keys[7],
            delegation_program: keys[8],
            system_program: keys[2],
        }
        .to_account_metas(None);
        let delegate_liquidity = crate::accounts::DelegateUserLiquidity {
            user: keys[0],
            buffer_user_liquidity: keys[9],
            delegation_record_user_liquidity: keys[10],
            delegation_metadata_user_liquidity: keys[11],
            user_liquidity: keys[3],
            owner_program: keys[7],
            delegation_program: keys[8],
            system_program: keys[2],
        }
        .to_account_metas(None);

        for metas in [
            initialize_positions,
            initialize_liquidity,
            delegate_positions,
            delegate_liquidity,
        ] {
            assert_eq!(
                metas
                    .iter()
                    .filter(|meta| meta.is_signer)
                    .map(|meta| meta.pubkey)
                    .collect::<Vec<_>>(),
                vec![keys[0]]
            );
        }
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    #[test]
    fn market_financial_cap_rejects_the_ninth_position_independent_of_user_state() {
        assert!(require_market_financial_capacity(0).is_ok());
        assert!(require_market_financial_capacity(7).is_ok());
        assert!(require_market_financial_capacity(8).is_err());
        assert!(require_market_financial_capacity(9).is_err());
    }
}
