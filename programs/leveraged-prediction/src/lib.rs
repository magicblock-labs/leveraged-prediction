use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
use hydra_api::instruction::ephemeral::find_crank_pda;
use solana_sha256_hasher::hashv;

pub mod error;
pub mod instructions;
pub mod math;
pub mod state;

use error::ErrorCode;
use instructions::*;
use state::{Direction, MarketMode};

pub(crate) use instructions::delegate_market::__client_accounts_delegate_market;
pub(crate) use instructions::deposit_liquidity::__client_accounts_deposit_liquidity;
pub(crate) use instructions::execute_withdrawal::__client_accounts_execute_withdrawal;
pub(crate) use instructions::initialize_market::__client_accounts_initialize_market;
pub(crate) use instructions::initialize_protocol_config::__client_accounts_initialize_protocol_config;
pub(crate) use instructions::initialize_user_position::__client_accounts_initialize_user_position;
pub(crate) use instructions::open_position::__client_accounts_open_position;
pub(crate) use instructions::request_withdrawal::__client_accounts_manage_withdrawal;
pub(crate) use instructions::set_market_mode::__client_accounts_admin_market;
pub(crate) use instructions::settle_position::__client_accounts_settle_position;
pub(crate) use instructions::withdraw_protocol_fees::__client_accounts_withdraw_protocol_fees;

declare_id!("AcvFWjSFrLAAWMynqQmBxeBe8wHRTVhhHtB6byatQLFr");

pub const CONFIG_SEED: &[u8] = b"protocol_config";
pub const MARKET_SEED: &[u8] = b"market";
pub const USER_POSITION_SEED: &[u8] = b"user_position";
pub const FEE_AUTHORITY_SEED: &[u8] = b"fee_authority";
pub const ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
pub const ORACLE_ACCOUNT: Pubkey = pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
pub const ORACLE_FEED_ID: [u8; 32] = [
    198, 173, 62, 132, 29, 156, 15, 36, 138, 223, 249, 12, 247, 118, 248, 57, 253, 89, 241, 203,
    216, 255, 188, 143, 148, 2, 136, 62, 161, 110, 132, 32,
];
pub const ORACLE_EXPONENT: i32 = 8;
pub const COLLATERAL_DECIMALS: u8 = 6;
pub const LEVERAGE: u16 = 1_000;
pub const POSITION_DURATION_SECONDS: i64 = 10;
pub const SETTLEMENT_BUFFER_SECONDS: i64 = 10;
pub const MAX_MARKET_FINANCIALLY_ACTIVE_POSITIONS: u32 = 8;
pub const MIN_POSITION_COLLATERAL: u64 = 1_000_000;
pub const MAX_POSITION_COLLATERAL: u64 = 1_000_000_000;
pub const MIN_INITIAL_LIQUIDITY: u64 = 100_000_000_000;
pub const MAX_INITIAL_LIQUIDITY: u64 = 100_000_000_000_000;
pub const USER_OPEN_COLLATERAL_BPS: u16 = 100;
pub const SAFETY_BUFFER_BPS: u16 = 1_000;
pub const PROFIT_FEE_BPS: u16 = 1_000;
pub const PROTOCOL_FEE_SHARE_BPS: u16 = 2_000;
pub const ORACLE_MAX_AGE_SECONDS: u16 = 2;
pub const ORACLE_MAX_CONFIDENCE_BPS: u16 = 1;
pub const HYDRA_FIRST_ATTEMPT_DELAY_SLOTS: u64 = 180;
pub const HYDRA_INTERVAL_SLOTS: u64 = 20;
pub const HYDRA_REMAINING_ATTEMPTS: u64 = 19;
pub const HYDRA_COMPUTE_UNIT_LIMIT: u32 = 300_000;

pub fn require_market_financial_capacity(active_positions: u32) -> Result<()> {
    require!(
        active_positions < MAX_MARKET_FINANCIALLY_ACTIVE_POSITIONS,
        ErrorCode::RiskLimitExceeded
    );
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleOutcome {
    AlreadyProcessed,
    PreExpiry,
    OracleNotReady,
    OracleOutsideWindow,
    Settled,
    Refunded,
}

#[event]
pub struct SettlePositionResult {
    pub nonce: u32,
    pub outcome: SettleOutcome,
    pub processed_at: i64,
    pub expires_at: i64,
    pub refund_at: i64,
    pub entry_price: i64,
    pub settlement_price: i64,
    pub oracle_publish_time: i64,
}

#[event]
pub struct MarketModeChanged {
    pub market: Pubkey,
    pub mode: MarketMode,
}

#[event]
pub struct LiquidityDeposited {
    pub market: Pubkey,
    pub user: Pubkey,
    pub assets: u64,
    pub shares: u128,
    pub equity_after: u64,
}

#[event]
pub struct WithdrawalRequested {
    pub market: Pubkey,
    pub user: Pubkey,
    pub shares: u128,
    pub min_assets_out: u64,
}

#[event]
pub struct WithdrawalCancelled {
    pub market: Pubkey,
    pub user: Pubkey,
    pub shares: u128,
}

#[event]
pub struct WithdrawalExecuted {
    pub market: Pubkey,
    pub user: Pubkey,
    pub shares: u128,
    pub assets: u64,
    pub equity_after: u64,
}

#[event]
pub struct ProtocolFeesWithdrawn {
    pub market: Pubkey,
    pub destination: Pubkey,
    pub assets: u64,
}

pub fn hydra_task_seed(market: Pubkey, user: Pubkey, nonce: u32, task_salt: [u8; 32]) -> [u8; 32] {
    hashv(&[
        b"leveraged_prediction_position",
        market.as_ref(),
        user.as_ref(),
        &nonce.to_le_bytes(),
        &task_salt,
    ])
    .to_bytes()
}

pub fn hydra_crank_address(
    market: Pubkey,
    user: Pubkey,
    nonce: u32,
    task_salt: [u8; 32],
) -> Pubkey {
    let seed = hydra_task_seed(market, user, nonce, task_salt);
    Pubkey::new_from_array(find_crank_pda(&seed).0.to_bytes())
}

#[ephemeral]
#[program]
pub mod leveraged_prediction {
    use super::*;

    pub fn initialize_protocol_config(ctx: Context<InitializeProtocolConfig>) -> Result<()> {
        instructions::initialize_protocol_config::handler(ctx)
    }

    pub fn initialize_market(ctx: Context<InitializeMarket>, sponsor_lamports: u64) -> Result<()> {
        instructions::initialize_market::handler(ctx, sponsor_lamports)
    }

    pub fn set_market_mode(ctx: Context<AdminMarket>, mode: MarketMode) -> Result<()> {
        instructions::set_market_mode::handler(ctx, mode)
    }

    pub fn delegate_market(ctx: Context<DelegateMarket>) -> Result<()> {
        instructions::delegate_market::handler(ctx)
    }

    pub fn initialize_user_position(ctx: Context<InitializeUserPosition>) -> Result<()> {
        instructions::initialize_user_position::handler(ctx)
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
    use anchor_lang::solana_program::sysvar::instructions::{
        BorrowedAccountMeta, BorrowedInstruction,
    };
    use anchor_lang::solana_program::sysvar::SysvarId;
    use hydra_api::instruction::ephemeral::PROGRAM_ID as HYDRA_EPHEMERAL_PROGRAM_ID;
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};

    #[test]
    fn position_task_salt_changes_the_crank_address() {
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        assert_ne!(
            hydra_crank_address(market, user, 1, [1; 32]),
            hydra_crank_address(market, user, 1, [2; 32])
        );
    }

    fn trigger_sysvar_data(
        program_id: &Pubkey,
        crank: &Pubkey,
        instruction_data: &[u8],
    ) -> Vec<u8> {
        let trigger = BorrowedInstruction {
            program_id,
            accounts: vec![BorrowedAccountMeta {
                pubkey: crank,
                is_signer: false,
                is_writable: true,
            }],
            data: instruction_data,
        };
        let current = BorrowedInstruction {
            program_id: &crate::ID,
            accounts: vec![],
            data: &[],
        };
        let mut data = construct_instructions_data(&[trigger, current]);
        store_current_index_checked(&mut data, 1).unwrap();
        data
    }

    fn check_trigger(data: &mut [u8], expected_crank: Pubkey) -> Result<()> {
        let key = Instructions::id();
        let owner = Pubkey::default();
        let mut lamports = 0;
        let account = AccountInfo::new(&key, false, false, &mut lamports, data, &owner, false);
        instructions::settle_position::require_hydra_trigger(&account, expected_crank)
    }

    #[test]
    fn previous_instruction_must_be_hydra_trigger() {
        let crank = Pubkey::new_unique();
        let mut valid = trigger_sysvar_data(
            &HYDRA_EPHEMERAL_PROGRAM_ID,
            &crank,
            &[hydra_api::consts::ix::TRIGGER],
        );
        assert!(check_trigger(&mut valid, crank).is_ok());

        let wrong_id = Pubkey::new_unique();
        let mut wrong_program =
            trigger_sysvar_data(&wrong_id, &crank, &[hydra_api::consts::ix::TRIGGER]);
        assert!(check_trigger(&mut wrong_program, crank).is_err());
        let mut wrong_discriminator =
            trigger_sysvar_data(&HYDRA_EPHEMERAL_PROGRAM_ID, &crank, &[0]);
        assert!(check_trigger(&mut wrong_discriminator, crank).is_err());
        let mut wrong_crank = trigger_sysvar_data(
            &HYDRA_EPHEMERAL_PROGRAM_ID,
            &crank,
            &[hydra_api::consts::ix::TRIGGER],
        );
        assert!(check_trigger(&mut wrong_crank, Pubkey::new_unique()).is_err());
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
