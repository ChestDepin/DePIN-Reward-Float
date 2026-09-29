use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::RewardFloatError;
use crate::state::{Pool, POOL_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    /// Becomes the pool authority, the key that may later replace the attestor.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, stable_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    /// The stablecoin loans are issued and repaid in.
    pub stable_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = stable_mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,

    // Derived rather than taken as given: the program data of any other program would
    // deserialize just as well, with whoever deployed it as its upgrade authority.
    #[account(
        seeds = [crate::ID.as_ref()],
        seeds::program = bpf_loader_upgradeable::ID,
        bump,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ RewardFloatError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_pool(
    ctx: Context<InitializePool>,
    attestor: Pubkey,
    base_apr_bps: u16,
    slope_apr_bps: u16,
) -> Result<()> {
    require!(
        u32::from(base_apr_bps) + u32::from(slope_apr_bps) <= u32::from(u16::MAX),
        RewardFloatError::InvalidRateCurve
    );
    ctx.accounts.pool.set_inner(Pool {
        authority: ctx.accounts.authority.key(),
        attestor,
        stable_mint: ctx.accounts.stable_mint.key(),
        vault: ctx.accounts.vault.key(),
        total_shares: 0,
        total_deposits: 0,
        total_borrowed: 0,
        accrued_interest: 0,
        overdue_principal: 0,
        base_apr_bps,
        slope_apr_bps,
        bump: ctx.bumps.pool,
    });
    Ok(())
}
