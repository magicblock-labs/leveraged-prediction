use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("amount must be non-zero")]
    InvalidAmount,
    #[msg("configuration is outside governance bounds")]
    InvalidConfig,
    #[msg("arithmetic overflow or invalid conversion")]
    MathOverflow,
    #[msg("market only permits closing existing risk")]
    MarketCloseOnly,
    #[msg("active risk prevents this share-changing operation")]
    ActiveRisk,
    #[msg("position exceeds market risk limits")]
    RiskLimitExceeded,
    #[msg("insufficient free liquidity")]
    InsufficientLiquidity,
    #[msg("slippage bound was not met")]
    SlippageExceeded,
    #[msg("a withdrawal is already pending")]
    WithdrawalAlreadyPending,
    #[msg("no withdrawal is pending")]
    NoPendingWithdrawal,
    #[msg("oracle exponent does not match the market")]
    OracleExponentMismatch,
    #[msg("oracle price or confidence is invalid")]
    InvalidOraclePrice,
    #[msg("market sponsor does not have enough lamports for UserPosition rent")]
    InsufficientSponsorLamports,
    #[msg("position nonce does not match market sequence")]
    InvalidNonce,
    #[msg("Hydra crank address does not match the position task seed")]
    InvalidHydraCrank,
    #[msg("position settlement was not invoked by its Hydra crank")]
    InvalidHydraTrigger,
    #[msg("market sponsor cannot fund the Hydra task and preserve its rent floor")]
    InsufficientHydraSponsorLamports,
    #[msg("Hydra task creation failed")]
    HydraTaskCreationFailed,
}
