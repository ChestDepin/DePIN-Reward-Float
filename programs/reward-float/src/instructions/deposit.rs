use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::RewardFloatError;
use crate::state::{LenderShare, Pool, SHARE_SEED};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,

    // Opened by the first deposit, so that lending stays one transaction.
    #[account(
        init_if_needed,
        payer = lender,
        space = 8 + LenderShare::INIT_SPACE,
        seeds = [SHARE_SEED, pool.key().as_ref(), lender.key().as_ref()],
        bump,
    )]
    pub lender_share: Box<Account<'info, LenderShare>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    // The token program refuses a source the lender cannot spend from.
    #[account(mut, token::mint = pool.stable_mint)]
    pub source: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    let shares = pool.shares_for_deposit(amount, now)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    pool.total_deposits = pool
        .total_deposits
        .checked_add(amount)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    let lender = ctx.accounts.lender.key();
    let share = &mut ctx.accounts.lender_share;
    if share.owner == Pubkey::default() {
        share.pool = pool.key();
        share.owner = lender;
        share.bump = ctx.bumps.lender_share;
    }
    share.shares = share
        .shares
        .checked_add(shares)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.lender.to_account_info(),
            },
        ),
        amount,
    )
}
