use anchor_lang::prelude::*;

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
    pub collateral_mint: Pubkey,
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
pub struct UserPosition {
    pub shares: u128,
    pub pending_withdrawal_shares: u128,
    pub min_assets_out: u64,
    #[max_len(8)]
    pub positions: Vec<CompactPosition>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub struct CompactPosition {
    pub nonce: u32,
    /// Authenticates the Hydra task created for this position.
    pub task_salt: [u8; 32],
    pub collateral: u32,
    pub entry_price: i64,
    pub expires_at: u32,
    pub direction: Direction,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_storage_budget_is_locked() {
        assert_eq!(ProtocolConfig::INIT_SPACE, 97);
        assert_eq!(Market::INIT_SPACE, 74);
        assert_eq!(CompactPosition::INIT_SPACE, 53);
        assert_eq!(UserPosition::INIT_SPACE, 468);

        assert_eq!(8 + Market::INIT_SPACE, 82);
        assert_eq!(8 + UserPosition::INIT_SPACE, 476);
    }

    #[test]
    fn no_risk_ignores_epoch_equity() {
        let market = Market {
            collateral_mint: Pubkey::default(),
            total_shares: 0,
            open_collateral: 0,
            risk_epoch_equity: 42,
            active_positions: 0,
            next_position_nonce: 0,
            mode: MarketMode::Open,
            bump: 0,
        };
        assert!(market.is_no_risk());
    }
}
