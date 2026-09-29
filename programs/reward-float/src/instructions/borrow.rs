use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_ID;

use crate::error::RewardFloatError;
use crate::instructions::verify_attestation::verify_limit_attestation;
use crate::state::{
    Loan, LoanStatus, OperatorAccount, Pool, LOAN_SEED, MAX_TERM_PERIODS, OPERATOR_SEED, POOL_SEED,
    REPAYMENT_PERIOD,
};

const BASIS_POINTS: u16 = 10_000;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,

    // Opened by the first loan rather than by an instruction of its own, so that
    // borrowing stays one transaction signed by the operator (FR-008).
    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + OperatorAccount::INIT_SPACE,
        seeds = [OPERATOR_SEED, operator.key().as_ref()],
        bump,
    )]
    pub operator_account: Box<Account<'info, OperatorAccount>>,

    #[account(
        init,
        payer = operator,
        space = 8 + Loan::INIT_SPACE,
        seeds = [LOAN_SEED, operator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub loan: Box<Account<'info, Loan>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = pool.stable_mint)]
    pub destination: Box<Account<'info, TokenAccount>>,

    pub reward_mint: Box<Account<'info, Mint>>,

    /// CHECK: pinned to the instructions sysvar, and only read through its helpers.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_borrow(
    ctx: Context<Borrow>,
    nonce: u64,
    amount: u64,
    term_periods: u8,
    sweep_bps: u16,
    max_apr_bps: u16,
) -> Result<()> {
    require!(amount > 0, RewardFloatError::InvalidAmount);
    require!(
        (1..=MAX_TERM_PERIODS).contains(&term_periods),
        RewardFloatError::InvalidTerm
    );
    require!(
        (1..=BASIS_POINTS).contains(&sweep_bps),
        RewardFloatError::InvalidSweepShare
    );

    let now = Clock::get()?.unix_timestamp;
    let operator = ctx.accounts.operator.key();
    let attestation = verify_limit_attestation(
        &ctx.accounts.instructions.to_account_info(),
        &ctx.accounts.pool.attestor,
        &operator,
        now,
    )?;
    // The loan address was derived from the nonce argument before this point. Unless it
    // is the attested nonce, the address says nothing about which attestation it spent.
    require!(
        attestation.nonce == nonce,
        RewardFloatError::AttestationNonceMismatch
    );

    let account = &mut ctx.accounts.operator_account;
    if account.owner == Pubkey::default() {
        account.owner = operator;
        account.bump = ctx.bumps.operator_account;
    }
    account.consume_nonce(nonce)?;
    require!(!account.overdue, RewardFloatError::OperatorOverdue);
    account.total_debt = account
        .total_debt
        .checked_add(amount)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    require!(
        account.total_debt <= attestation.limit,
        RewardFloatError::CreditLimitExceeded
    );
    account.open_loans = account
        .open_loans
        .checked_add(1)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    let pool = &mut ctx.accounts.pool;
    require!(
        amount <= pool.free_liquidity()?,
        RewardFloatError::InsufficientLiquidity
    );
    let apr_bps = pool.quote_apr_bps(amount)?;
    require!(apr_bps <= max_apr_bps, RewardFloatError::RateAboveMaximum);
    pool.total_borrowed = pool
        .total_borrowed
        .checked_add(amount)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    let due_at = i64::from(term_periods)
        .checked_mul(REPAYMENT_PERIOD)
        .and_then(|term| now.checked_add(term))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    ctx.accounts.loan.set_inner(Loan {
        operator,
        pool: pool.key(),
        reward_mint: ctx.accounts.reward_mint.key(),
        nonce,
        principal: amount,
        outstanding: amount,
        accrued_interest: 0,
        opened_at: now,
        due_at,
        last_accrual_at: now,
        apr_bps,
        sweep_bps,
        status: LoanStatus::Active,
        bump: ctx.bumps.loan,
    });

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
        amount,
    )
}
