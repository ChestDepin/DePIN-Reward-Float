use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::RewardFloatError;
use crate::state::{Loan, LoanStatus, OperatorAccount, Pool, OPERATOR_SEED};

// Anyone may pay a loan down, not only its operator: settling someone's debt cannot
// hurt them, and the sweep of US3 pays from money the operator does not sign for.
#[derive(Accounts)]
pub struct Repay<'info> {
    pub payer: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,

    // Only `borrow` creates accounts of this type, and always at the loan PDA, so the
    // owner and discriminator checks already say this is a genuine loan.
    #[account(mut, has_one = pool)]
    pub loan: Box<Account<'info, Loan>>,

    #[account(
        mut,
        seeds = [OPERATOR_SEED, loan.operator.as_ref()],
        bump = operator_account.bump,
    )]
    pub operator_account: Box<Account<'info, OperatorAccount>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    // The token program refuses a source the payer cannot spend from.
    #[account(mut, token::mint = pool.stable_mint)]
    pub source: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_repay(ctx: Context<Repay>, max_amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let loan = &mut ctx.accounts.loan;
    let pool = &mut ctx.accounts.pool;
    pool.untrack(loan)?;
    let accrued = loan.accrue(now)?;
    let repayment = loan.apply_repayment(max_amount)?;
    pool.track(loan)?;
    let paid = repayment.total();

    let account = &mut ctx.accounts.operator_account;
    account.total_debt = account
        .total_debt
        .checked_add(accrued)
        .and_then(|debt| debt.checked_sub(paid))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    if loan.status == LoanStatus::Repaid {
        account.open_loans = account
            .open_loans
            .checked_sub(1)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    }

    pool.total_borrowed = pool
        .total_borrowed
        .checked_sub(repayment.principal)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    pool.accrued_interest = pool
        .accrued_interest
        .checked_add(accrued)
        .and_then(|receivable| receivable.checked_sub(repayment.interest))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    // Paid-in interest is the lenders' income: it becomes cash the pool can lend again.
    pool.total_deposits = pool
        .total_deposits
        .checked_add(repayment.interest)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        paid,
    )
}
