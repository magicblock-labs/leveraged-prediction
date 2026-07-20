use super::*;
use ephemeral_rollups_sdk::{
    anchor::commit,
    ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder},
};

pub fn handler(ctx: Context<UndelegateUserLiquidity>) -> Result<()> {
    ctx.accounts.user_liquidity.require_empty()?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.user.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.user_liquidity.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateUserLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [USER_LIQUIDITY_SEED, user.key().as_ref()], bump)]
    pub user_liquidity: Account<'info, UserLiquidity>,
}
