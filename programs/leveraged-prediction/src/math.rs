use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::Direction;
use crate::MAX_GROSS_PROFIT_MULTIPLIER;

pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettlementAmounts {
    pub user_payout: u64,
    pub protocol_fee: u64,
    pub lp_fee: u64,
    pub gross_profit: u64,
    pub loss: u64,
}

pub fn shares_for_deposit(amount: u64, equity_before: u64, total_shares: u128) -> Result<u128> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    if total_shares == 0 {
        let equity_after = equity_before
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        return Ok(u128::from(equity_after));
    }
    require!(equity_before > 0, ErrorCode::InvalidConfig);
    let shares = u128::from(amount)
        .checked_mul(total_shares)
        .and_then(|value| value.checked_div(u128::from(equity_before)))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(shares > 0, ErrorCode::InvalidAmount);
    Ok(shares)
}

pub fn require_deposit_capacity(
    equity_before: u64,
    amount: u64,
    maximum_market_equity: u64,
    is_first_lp: bool,
) -> Result<u64> {
    let equity_after = equity_before
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    if !is_first_lp {
        require!(
            equity_after <= maximum_market_equity,
            ErrorCode::RiskLimitExceeded
        );
    }
    Ok(equity_after)
}

pub fn bounded_risk_epoch_equity(realized_equity: u64, maximum_equity: u64) -> u64 {
    realized_equity.min(maximum_equity)
}

pub fn require_user_open_collateral_capacity(
    existing_user_collateral: u64,
    new_collateral: u64,
    risk_epoch_equity: u64,
    maximum_bps: u16,
) -> Result<u64> {
    let collateral_after = existing_user_collateral
        .checked_add(new_collateral)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        u128::from(collateral_after)
            .checked_mul(BPS)
            .ok_or(ErrorCode::MathOverflow)?
            <= u128::from(risk_epoch_equity)
                .checked_mul(u128::from(maximum_bps))
                .ok_or(ErrorCode::MathOverflow)?,
        ErrorCode::RiskLimitExceeded
    );
    Ok(collateral_after)
}

pub fn assets_for_shares(shares: u128, pool_balance: u64, total_shares: u128) -> Result<u64> {
    require!(
        shares > 0 && total_shares >= shares,
        ErrorCode::InvalidAmount
    );
    let assets = shares
        .checked_mul(u128::from(pool_balance))
        .and_then(|value| value.checked_div(total_shares))
        .ok_or(ErrorCode::MathOverflow)?;
    u64::try_from(assets).map_err(|_| ErrorCode::MathOverflow.into())
}

pub fn require_collateral_bounds(collateral: u64, minimum: u64, maximum: u64) -> Result<()> {
    require!(
        collateral >= minimum && collateral <= maximum,
        ErrorCode::InvalidAmount
    );
    Ok(())
}

pub fn require_open_liquidity(
    total_shares: u128,
    risk_epoch_equity: u64,
    pool_before: u64,
    minimum_open_liquidity: u64,
) -> Result<()> {
    require!(total_shares > 0, ErrorCode::InsufficientLiquidity);
    require!(
        risk_epoch_equity >= minimum_open_liquidity && pool_before >= minimum_open_liquidity,
        ErrorCode::InsufficientLiquidity
    );
    Ok(())
}

pub fn compact_position_values(collateral: u64, expires_at: i64) -> Result<(u32, u32)> {
    let collateral = u32::try_from(collateral).map_err(|_| ErrorCode::MathOverflow)?;
    let expires_at = u32::try_from(expires_at).map_err(|_| ErrorCode::MathOverflow)?;
    Ok((collateral, expires_at))
}

pub fn require_post_open_solvency(
    pool_equity_before: u64,
    existing_open_collateral: u64,
    open_collateral_after: u64,
    safety_buffer_bps: u16,
) -> Result<()> {
    let safety = u128::from(pool_equity_before)
        .checked_mul(u128::from(safety_buffer_bps))
        .and_then(|value| value.checked_div(BPS))
        .ok_or(ErrorCode::MathOverflow)?;
    let profit_reserve = u128::from(open_collateral_after)
        .checked_mul(u128::from(MAX_GROSS_PROFIT_MULTIPLIER))
        .ok_or(ErrorCode::MathOverflow)?;
    let required = u128::from(existing_open_collateral)
        .checked_add(profit_reserve)
        .and_then(|value| value.checked_add(safety))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        u128::from(pool_equity_before) >= required,
        ErrorCode::InsufficientLiquidity
    );
    Ok(())
}

pub fn require_valid_withdrawal_remainder(
    mode: crate::state::MarketMode,
    remaining_assets: u64,
    remaining_shares: u128,
    minimum_open_liquidity: u64,
) -> Result<()> {
    if mode == crate::state::MarketMode::Open {
        require!(
            remaining_shares > 0 && remaining_assets >= minimum_open_liquidity,
            ErrorCode::InsufficientLiquidity
        );
    }
    Ok(())
}

pub fn calculate_settlement(
    collateral: u64,
    entry_price: i64,
    settle_price: i64,
    direction: Direction,
    leverage: u16,
    profit_fee_bps: u16,
    protocol_fee_share_bps: u16,
) -> Result<SettlementAmounts> {
    require!(
        collateral > 0 && entry_price > 0 && settle_price > 0,
        ErrorCode::InvalidAmount
    );
    let delta = i128::from(settle_price)
        .checked_sub(i128::from(entry_price))
        .ok_or(ErrorCode::MathOverflow)?;
    let directed_delta = match direction {
        Direction::Up => delta,
        Direction::Down => delta.checked_neg().ok_or(ErrorCode::MathOverflow)?,
    };
    let numerator = i128::from(collateral)
        .checked_mul(i128::from(leverage))
        .and_then(|value| value.checked_mul(directed_delta))
        .ok_or(ErrorCode::MathOverflow)?;
    let raw = numerator
        .checked_div(i128::from(entry_price))
        .ok_or(ErrorCode::MathOverflow)?;

    if raw >= 0 {
        let maximum_gross_profit = collateral
            .checked_mul(u64::from(MAX_GROSS_PROFIT_MULTIPLIER))
            .ok_or(ErrorCode::MathOverflow)?;
        let gross_profit = u64::try_from(raw.min(i128::from(maximum_gross_profit)))
            .map_err(|_| ErrorCode::MathOverflow)?;
        let fee = u128::from(gross_profit)
            .checked_mul(u128::from(profit_fee_bps))
            .and_then(|value| value.checked_div(BPS))
            .ok_or(ErrorCode::MathOverflow)?;
        let protocol_fee = fee
            .checked_mul(u128::from(protocol_fee_share_bps))
            .and_then(|value| value.checked_div(BPS))
            .ok_or(ErrorCode::MathOverflow)?;
        let fee_u64 = u64::try_from(fee).map_err(|_| ErrorCode::MathOverflow)?;
        let protocol_fee_u64 = u64::try_from(protocol_fee).map_err(|_| ErrorCode::MathOverflow)?;
        let user_payout = collateral
            .checked_add(gross_profit)
            .and_then(|value| value.checked_sub(fee_u64))
            .ok_or(ErrorCode::MathOverflow)?;
        Ok(SettlementAmounts {
            user_payout,
            protocol_fee: protocol_fee_u64,
            lp_fee: fee_u64
                .checked_sub(protocol_fee_u64)
                .ok_or(ErrorCode::MathOverflow)?,
            gross_profit,
            loss: 0,
        })
    } else {
        let loss = u64::try_from(raw.unsigned_abs().min(u128::from(collateral)))
            .map_err(|_| ErrorCode::MathOverflow)?;
        Ok(SettlementAmounts {
            user_payout: collateral
                .checked_sub(loss)
                .ok_or(ErrorCode::MathOverflow)?,
            protocol_fee: 0,
            lp_fee: 0,
            gross_profit: 0,
            loss,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_pnl_caps_both_sides() {
        let win =
            calculate_settlement(1_000_000, 100_000, 100_100, Direction::Up, 1000, 1000, 2000)
                .unwrap();
        assert_eq!(win.gross_profit, 1_000_000);
        assert_eq!(win.user_payout, 1_900_000);
        assert_eq!(win.protocol_fee, 20_000);
        assert_eq!(win.lp_fee, 80_000);

        let loss =
            calculate_settlement(1_000_000, 100_000, 99_900, Direction::Up, 1000, 1000, 2000)
                .unwrap();
        assert_eq!(loss.loss, 1_000_000);
        assert_eq!(loss.user_payout, 0);
    }

    #[test]
    fn favorable_pnl_caps_at_five_times_collateral_before_fee() {
        let win =
            calculate_settlement(1_000_000, 100_000, 101_000, Direction::Up, 1000, 1000, 2000)
                .unwrap();
        assert_eq!(win.gross_profit, 5_000_000);
        assert_eq!(win.user_payout, 5_500_000);
        assert_eq!(win.protocol_fee, 100_000);
        assert_eq!(win.lp_fee, 400_000);
    }

    #[test]
    fn signed_non_divisible_pnl_truncates_toward_zero() {
        let positive = calculate_settlement(
            1_000_001,
            100_000_000,
            100_000_001,
            Direction::Up,
            1000,
            1000,
            2000,
        )
        .unwrap();
        assert_eq!(positive.user_payout, 1_000_010);
        assert_eq!(positive.gross_profit, 10);
        assert_eq!(positive.lp_fee, 1);

        let negative = calculate_settlement(
            1_000_001,
            100_000_000,
            99_999_999,
            Direction::Up,
            1000,
            1000,
            2000,
        )
        .unwrap();
        assert_eq!(negative.user_payout, 999_991);
        assert_eq!(negative.loss, 10);
    }

    #[test]
    fn combined_directional_payout_stays_within_the_five_times_profit_cap() {
        for settle in 90_000..=110_000 {
            let up =
                calculate_settlement(1_000_000, 100_000, settle, Direction::Up, 1000, 1000, 2000)
                    .unwrap();
            let down = calculate_settlement(
                1_000_000,
                100_000,
                settle,
                Direction::Down,
                1000,
                1000,
                2000,
            )
            .unwrap();
            assert!(up.user_payout + down.user_payout <= 5_500_000);
        }
    }

    #[test]
    fn shares_reprice_without_rebasing() {
        assert_eq!(shares_for_deposit(100, 0, 0).unwrap(), 100);
        assert_eq!(shares_for_deposit(100, 7, 0).unwrap(), 107);
        assert_eq!(shares_for_deposit(50, 200, 100).unwrap(), 25);
        assert_eq!(assets_for_shares(25, 250, 125).unwrap(), 50);
    }

    #[test]
    fn later_deposits_are_capped_but_first_lp_can_absorb_donations() {
        assert_eq!(require_deposit_capacity(7, 93, 100, false).unwrap(), 100);
        assert!(require_deposit_capacity(7, 94, 100, false).is_err());
        assert_eq!(require_deposit_capacity(99, 2, 100, true).unwrap(), 101);
        assert!(require_deposit_capacity(u64::MAX, 1, u64::MAX, true).is_err());
    }

    #[test]
    fn donations_cannot_raise_the_governed_risk_epoch_cap() {
        assert_eq!(bounded_risk_epoch_equity(99, 100), 99);
        assert_eq!(bounded_risk_epoch_equity(101, 100), 100);
    }

    #[test]
    fn aggregate_user_collateral_cannot_bypass_the_per_user_limit() {
        assert_eq!(
            require_user_open_collateral_capacity(40, 10, 1_000, 500).unwrap(),
            50
        );
        assert!(require_user_open_collateral_capacity(40, 11, 1_000, 500).is_err());
        assert!(require_user_open_collateral_capacity(u64::MAX, 1, u64::MAX, 10_000).is_err());
    }

    #[test]
    fn collateral_bounds_are_inclusive_and_reject_zero() {
        assert!(require_collateral_bounds(1_000_000, 1_000_000, 1_000_000_000).is_ok());
        assert!(require_collateral_bounds(1_000_000_000, 1_000_000, 1_000_000_000).is_ok());
        assert!(require_collateral_bounds(0, 1_000_000, 1_000_000_000).is_err());
        assert!(require_collateral_bounds(1_000_000_001, 1_000_000, 1_000_000_000).is_err());
    }

    #[test]
    fn open_requires_seeded_shares_and_minimum_epoch_and_pool_equity() {
        assert!(require_open_liquidity(1, 100, 100, 100).is_ok());
        assert!(require_open_liquidity(0, 100, 100, 100).is_err());
        assert!(require_open_liquidity(1, 99, 100, 100).is_err());
        assert!(require_open_liquidity(1, 100, 99, 100).is_err());
    }

    #[test]
    fn compact_position_conversions_are_checked_at_boundaries() {
        assert_eq!(
            compact_position_values(u64::from(u32::MAX), i64::from(u32::MAX)).unwrap(),
            (u32::MAX, u32::MAX)
        );
        assert!(compact_position_values(u64::from(u32::MAX) + 1, 0).is_err());
        assert!(compact_position_values(0, -1).is_err());
        assert!(compact_position_values(0, i64::from(u32::MAX) + 1).is_err());
    }

    #[test]
    fn post_open_solvency_uses_current_equity_after_rolling_losses() {
        assert!(require_post_open_solvency(330, 40, 50, 1_000).is_ok());
        assert!(require_post_open_solvency(320, 40, 50, 1_000).is_err());
    }

    #[test]
    fn post_open_solvency_includes_existing_risk_and_safety() {
        assert!(require_post_open_solvency(330, 40, 50, 1_000).is_ok());
        assert!(require_post_open_solvency(322, 41, 50, 1_000).is_err());
    }

    #[test]
    fn open_market_preserves_supply_and_minimum_but_close_only_can_empty() {
        assert!(
            require_valid_withdrawal_remainder(crate::state::MarketMode::Open, 100, 1, 100).is_ok()
        );
        assert!(
            require_valid_withdrawal_remainder(crate::state::MarketMode::Open, 99, 1, 100).is_err()
        );
        assert!(
            require_valid_withdrawal_remainder(crate::state::MarketMode::Open, 100, 0, 100)
                .is_err()
        );
        assert!(
            require_valid_withdrawal_remainder(crate::state::MarketMode::CloseOnly, 0, 0, 100)
                .is_ok()
        );
    }
}
