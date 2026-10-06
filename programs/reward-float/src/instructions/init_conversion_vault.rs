use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::RewardFloatError;
use crate::state::{
    ConversionVault, Pool, CONVERSION_REWARD_SEED, CONVERSION_SEED, CONVERSION_STABLE_SEED,
};

// A spread of 10 000 bps quotes nothing, and a tolerance of 10 000 bps accepts a quote of
// nothing: either way a withholding would take rewards and repay no debt (FR-015a).
const MAX_BPS: u16 = 10_000;

#[derive(Accounts)]
pub struct InitConversionVault<'info> {
    // The pool authority: the tolerance of FR-015a decides when withholding is skipped,
    // and the first caller would otherwise set it for the pool.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority @ RewardFloatError::NotPoolAuthority)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        init,
        payer = authority,
        space = 8 + ConversionVault::INIT_SPACE,
        seeds = [CONVERSION_SEED, pool.key().as_ref(), reward_mint.key().as_ref()],
        bump,
    )]
    pub conversion_vault: Box<Account<'info, ConversionVault>>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(address = pool.stable_mint)]
    pub stable_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        seeds = [CONVERSION_STABLE_SEED, conversion_vault.key().as_ref()],
        bump,
        token::mint = stable_mint,
        token::authority = conversion_vault,
    )]
    pub stable_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        seeds = [CONVERSION_REWARD_SEED, conversion_vault.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = conversion_vault,
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_conversion_vault(
    ctx: Context<InitConversionVault>,
    spread_bps: u16,
    max_slippage_bps: u16,
) -> Result<()> {
    require!(
        spread_bps < MAX_BPS && max_slippage_bps < MAX_BPS,
        RewardFloatError::InvalidConversionTerms
    );
    require_keys_neq!(
        ctx.accounts.reward_mint.key(),
        ctx.accounts.pool.stable_mint,
        RewardFloatError::RewardMintIsStablecoin
    );
    ctx.accounts.conversion_vault.set_inner(ConversionVault {
        pool: ctx.accounts.pool.key(),
        reward_mint: ctx.accounts.reward_mint.key(),
        stable_vault: ctx.accounts.stable_vault.key(),
        reward_vault: ctx.accounts.reward_vault.key(),
        spread_bps,
        max_slippage_bps,
        bump: ctx.bumps.conversion_vault,
    });
    Ok(())
}
