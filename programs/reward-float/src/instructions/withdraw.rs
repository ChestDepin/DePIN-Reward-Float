use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::RewardFloatError;
use crate::state::{LenderShare, Pool, WithdrawalLimit, POOL_SEED, SHARE_SEED};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub lender: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SHARE_SEED, pool.key().as_ref(), lender.key().as_ref()],
        bump = lender_share.bump,
    )]
    pub lender_share: Box<Account<'info, LenderShare>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = pool.stable_mint)]
    pub destination: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// What a withdrawal paid and, when it is less than the lender asked for, why (FR-020).
#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub lender: Pubkey,
    pub requested: u64,
    pub paid: u64,
    pub shares_burned: u64,
    pub limited_by: Option<WithdrawalLimit>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, max_amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let share = &mut ctx.accounts.lender_share;
    let pool = &mut ctx.accounts.pool;
    let withdrawal = pool.withdrawal(share.shares, max_amount, now)?;

    share.shares = share
        .shares
        .checked_sub(withdrawal.shares)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    pool.total_shares = pool
        .total_shares
        .checked_sub(withdrawal.shares)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    pool.total_deposits = pool
        .total_deposits
        .checked_sub(withdrawal.paid)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    let stable_mint = pool.stable_mint;
    let signer: &[&[&[u8]]] = &[&[POOL_SEED, stable_mint.as_ref(), &[pool.bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        ),
        withdrawal.paid,
    )?;

    emit!(Withdrawn {
        pool: pool.key(),
        lender: ctx.accounts.lender.key(),
        requested: max_amount,
        paid: withdrawal.paid,
        shares_burned: withdrawal.shares,
        limited_by: withdrawal.limited_by,
    });
    Ok(())
}
