use anchor_lang::prelude::*;

use crate::error::ErrorCode;

const USER_POSITIONS_CAPACITY: usize = 8;
const USER_LIQUIDITY_MARKET_CAPACITY: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub enum MarketMode {
    Open,
    CloseOnly,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub fee_authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub market_id: u16,
    pub oracle: Pubkey,
    pub oracle_feed_id: [u8; 32],
    pub total_shares: u128,
    pub open_collateral: u64,
    pub risk_epoch_equity: u64,
    pub active_positions: u32,
    pub next_position_nonce: u32,
    pub mode: MarketMode,
    pub bump: u8,
}

impl Market {
    pub fn is_no_risk(&self) -> bool {
        self.active_positions == 0 && self.open_collateral == 0
    }
}

#[account]
#[derive(InitSpace)]
pub struct UserPositions {
    #[max_len(USER_POSITIONS_CAPACITY)]
    pub positions: Vec<CompactPosition>,
}

impl UserPositions {
    pub fn require_capacity(&self) -> Result<()> {
        require!(
            self.positions.len() < USER_POSITIONS_CAPACITY,
            ErrorCode::UserPositionsCapacityExceeded
        );
        Ok(())
    }

    pub fn position_index(&self, market_id: u16, nonce: u32) -> Option<usize> {
        self.positions
            .iter()
            .position(|position| position.market_id == market_id && position.nonce == nonce)
    }

    pub fn open_collateral(&self, market_id: u16) -> Result<u64> {
        self.positions
            .iter()
            .filter(|position| position.market_id == market_id)
            .try_fold(0_u64, |sum, position| {
                sum.checked_add(u64::from(position.collateral))
                    .ok_or_else(|| error!(ErrorCode::MathOverflow))
            })
    }
}

#[account]
#[derive(InitSpace)]
pub struct UserLiquidity {
    #[max_len(USER_LIQUIDITY_MARKET_CAPACITY)]
    pub markets: Vec<MarketLiquidity>,
}

impl UserLiquidity {
    pub fn require_empty(&self) -> Result<()> {
        require!(self.markets.is_empty(), ErrorCode::ActiveUserLiquidity);
        Ok(())
    }

    pub fn market(&self, market_id: u16) -> Option<&MarketLiquidity> {
        self.markets
            .iter()
            .find(|entry| entry.market_id == market_id)
    }

    pub fn market_mut(&mut self, market_id: u16) -> Option<&mut MarketLiquidity> {
        self.markets
            .iter_mut()
            .find(|entry| entry.market_id == market_id)
    }

    pub fn market_or_insert_mut(&mut self, market_id: u16) -> Result<&mut MarketLiquidity> {
        if let Some(index) = self
            .markets
            .iter()
            .position(|entry| entry.market_id == market_id)
        {
            return Ok(&mut self.markets[index]);
        }
        require!(
            self.markets.len() < USER_LIQUIDITY_MARKET_CAPACITY,
            ErrorCode::UserLiquidityCapacityExceeded
        );
        let index = self.markets.len();
        self.markets.push(MarketLiquidity {
            market_id,
            shares: 0,
            pending_withdrawal_shares: 0,
            min_assets_out: 0,
        });
        Ok(&mut self.markets[index])
    }

    pub fn remove_empty_market(&mut self, market_id: u16) {
        if let Some(index) = self.markets.iter().position(|entry| {
            entry.market_id == market_id
                && entry.shares == 0
                && entry.pending_withdrawal_shares == 0
        }) {
            self.markets.swap_remove(index);
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub struct MarketLiquidity {
    pub market_id: u16,
    pub shares: u128,
    pub pending_withdrawal_shares: u128,
    pub min_assets_out: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub struct CompactPosition {
    pub market_id: u16,
    pub nonce: u32,
    /// Makes the native scheduler task ID unique and binds retries to this position.
    pub task_salt: [u8; 32],
    pub collateral: u32,
    pub entry_price: i64,
    pub expires_at: u32,
    pub direction: Direction,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FEE_AUTHORITY_SEED, MARKET_SEED};
    use anchor_spl::associated_token::get_associated_token_address;

    #[test]
    fn account_storage_budget_is_locked() {
        assert_eq!(ProtocolConfig::INIT_SPACE, 97);
        assert_eq!(Market::INIT_SPACE, 108);
        assert_eq!(CompactPosition::INIT_SPACE, 55);
        assert_eq!(MarketLiquidity::INIT_SPACE, 42);
        assert_eq!(UserPositions::INIT_SPACE, 444);
        assert_eq!(UserLiquidity::INIT_SPACE, 340);

        assert_eq!(8 + Market::INIT_SPACE, 116);
        assert_eq!(8 + UserPositions::INIT_SPACE, 452);
        assert_eq!(8 + UserLiquidity::INIT_SPACE, 348);
        assert_eq!(Rent::default().minimum_balance(452), 4_036_800);
        assert_eq!(Rent::default().minimum_balance(348), 3_312_960);
    }

    #[test]
    fn global_collateral_config_is_stable_across_distinct_market_oracles() {
        let collateral_mint = Pubkey::new_unique();
        let config = ProtocolConfig {
            admin: Pubkey::new_unique(),
            fee_authority: Pubkey::new_unique(),
            collateral_mint,
            bump: 1,
        };
        let first_oracle = Pubkey::new_unique();
        let second_oracle = Pubkey::new_unique();
        let first_feed = [1; 32];
        let second_feed = [2; 32];
        let (first_market_address, _) =
            Pubkey::find_program_address(&[MARKET_SEED, &1_u16.to_le_bytes()], &crate::ID);
        let (second_market_address, _) =
            Pubkey::find_program_address(&[MARKET_SEED, &2_u16.to_le_bytes()], &crate::ID);
        let (first_fee_authority, _) = Pubkey::find_program_address(
            &[FEE_AUTHORITY_SEED, first_market_address.as_ref()],
            &crate::ID,
        );
        let (second_fee_authority, _) = Pubkey::find_program_address(
            &[FEE_AUTHORITY_SEED, second_market_address.as_ref()],
            &crate::ID,
        );
        let first_pool = get_associated_token_address(&first_market_address, &collateral_mint);
        let second_pool = get_associated_token_address(&second_market_address, &collateral_mint);
        let first_fee_account =
            get_associated_token_address(&first_fee_authority, &collateral_mint);
        let second_fee_account =
            get_associated_token_address(&second_fee_authority, &collateral_mint);
        let mut first_market = market_fixture(1, first_oracle, first_feed);
        let second_market = market_fixture(2, second_oracle, second_feed);

        first_market.total_shares = 10_000;
        first_market.open_collateral = 2_000;
        first_market.risk_epoch_equity = 50_000;
        first_market.active_positions = 3;

        assert_eq!(config.collateral_mint, collateral_mint);
        assert_ne!(first_market_address, second_market_address);
        assert_ne!(first_pool, second_pool);
        assert_ne!(first_fee_authority, second_fee_authority);
        assert_ne!(first_fee_account, second_fee_account);
        assert_ne!(first_market.market_id, second_market.market_id);
        assert_ne!(first_market.oracle, second_market.oracle);
        assert_ne!(first_market.oracle_feed_id, second_market.oracle_feed_id);
        assert_eq!(second_market.total_shares, 0);
        assert_eq!(second_market.open_collateral, 0);
        assert_eq!(second_market.risk_epoch_equity, 0);
        assert_eq!(second_market.active_positions, 0);
    }

    #[test]
    fn no_risk_ignores_epoch_equity() {
        let mut market = market_fixture(0, Pubkey::new_unique(), [1; 32]);
        market.risk_epoch_equity = 42;
        assert!(market.is_no_risk());
    }

    #[test]
    fn liquidity_entries_are_isolated_and_empty_entries_reclaim_capacity() {
        let mut liquidity = UserLiquidity {
            markets: Vec::new(),
        };
        liquidity.market_or_insert_mut(7).unwrap().shares = 100;
        liquidity
            .market_or_insert_mut(9)
            .unwrap()
            .pending_withdrawal_shares = 20;

        assert_eq!(liquidity.market(7).unwrap().shares, 100);
        assert_eq!(liquidity.market(7).unwrap().pending_withdrawal_shares, 0);
        assert_eq!(liquidity.market(9).unwrap().shares, 0);
        assert_eq!(liquidity.market(9).unwrap().pending_withdrawal_shares, 20);

        liquidity.market_mut(7).unwrap().shares = 0;
        liquidity.remove_empty_market(7);
        assert!(liquidity.market(7).is_none());
        assert_eq!(liquidity.markets.len(), 1);
    }

    #[test]
    fn liquidity_market_capacity_is_bounded() {
        let mut liquidity = UserLiquidity {
            markets: Vec::new(),
        };
        for market_id in 0..USER_LIQUIDITY_MARKET_CAPACITY as u16 {
            liquidity.market_or_insert_mut(market_id).unwrap().shares = 1;
        }
        assert!(liquidity
            .market_or_insert_mut(USER_LIQUIDITY_MARKET_CAPACITY as u16)
            .is_err());
    }

    #[test]
    fn positions_with_the_same_nonce_are_isolated_by_market() {
        let positions = UserPositions {
            positions: vec![position_fixture(1, 7, 10), position_fixture(2, 7, 20)],
        };

        assert_eq!(positions.position_index(1, 7), Some(0));
        assert_eq!(positions.position_index(2, 7), Some(1));
        assert_eq!(positions.position_index(3, 7), None);
        assert_eq!(positions.open_collateral(1).unwrap(), 10);
        assert_eq!(positions.open_collateral(2).unwrap(), 20);
    }

    #[test]
    fn positions_capacity_is_bounded_across_markets() {
        let mut positions = UserPositions {
            positions: Vec::new(),
        };
        for market_id in 0..USER_POSITIONS_CAPACITY as u16 {
            assert!(positions.require_capacity().is_ok());
            positions.positions.push(position_fixture(market_id, 0, 1));
        }
        assert!(positions.require_capacity().is_err());
    }

    #[test]
    fn only_empty_liquidity_state_can_be_undelegated() {
        let mut liquidity = UserLiquidity {
            markets: Vec::new(),
        };
        assert!(liquidity.require_empty().is_ok());

        liquidity.market_or_insert_mut(1).unwrap().shares = 1;
        assert!(liquidity.require_empty().is_err());
    }

    fn market_fixture(market_id: u16, oracle: Pubkey, oracle_feed_id: [u8; 32]) -> Market {
        Market {
            market_id,
            oracle,
            oracle_feed_id,
            total_shares: 0,
            open_collateral: 0,
            risk_epoch_equity: 0,
            active_positions: 0,
            next_position_nonce: 0,
            mode: MarketMode::Open,
            bump: 0,
        }
    }

    fn position_fixture(market_id: u16, nonce: u32, collateral: u32) -> CompactPosition {
        CompactPosition {
            market_id,
            nonce,
            task_salt: [1; 32],
            collateral,
            entry_price: 1,
            expires_at: 1,
            direction: Direction::Up,
        }
    }
}
