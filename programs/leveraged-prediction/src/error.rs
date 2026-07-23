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
    #[msg("the user positions account is at capacity")]
    UserPositionsCapacityExceeded,
    #[msg("the user liquidity account is at market capacity")]
    UserLiquidityCapacityExceeded,
    #[msg("the user has no liquidity entry for this market")]
    UserLiquidityMarketNotFound,
    #[msg("active shares or withdrawals prevent user liquidity-state undelegation")]
    ActiveUserLiquidity,
    #[msg("position nonce does not match market sequence")]
    InvalidNonce,
    #[msg("settlement task salt or scheduler signer is invalid")]
    InvalidSettlementTask,
    #[msg("position settlement was not invoked by its MagicBlock scheduler")]
    InvalidSettlementTrigger,
    #[msg("MagicBlock settlement task creation failed")]
    SettlementTaskCreationFailed,
    #[msg("user token account is not owned by the session authority")]
    InvalidTokenOwner,
    #[msg("user token account mint does not match protocol collateral")]
    TokenMintMismatch,
    #[msg("session signer is not the approved token delegate")]
    InvalidSessionTokenDelegate,
    #[msg("session token allowance is smaller than the requested collateral")]
    InsufficientSessionTokenAllowance,
}
