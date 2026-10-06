use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount};
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount, Transfer};
use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_ID;

use crate::error::RewardFloatError;
use crate::instructions::verify_attestation::{verify_limit_attestation, verify_rate_attestation};
use crate::state::{
    Loan, LoanStatus, OperatorAccount, Pool, LOAN_SEED, MAX_OPEN_LOANS, MAX_TERM_PERIODS,
    OPERATOR_SEED, POOL_SEED, REPAYMENT_PERIOD,
};

const BASIS_POINTS: u16 = 10_000;

// The rate is in stablecoin base units for this many reward base units.
const RATE_UNIT: u128 = 1_000_000_000_000;

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

    // Created in the handler, after the nonce is spent: Anchor runs every `init` before
    // any handler code, so an `init` here would refuse an exact replay as an address
    // already in use before the nonce mask ever saw it (FR-012b).
    /// CHECK: the loan PDA of this operator and nonce, created by `borrow` itself.
    #[account(
        mut,
        seeds = [LOAN_SEED, operator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub loan: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = pool.stable_mint)]
    pub destination: Box<Account<'info, TokenAccount>>,

    pub reward_mint: Box<Account<'info, Mint>>,

    // Where the rewards the loan is repaid from arrive. A loan does not go out without
    // the protocol's permission on it: that permission is the collateral (FR-014).
    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = operator,
    )]
    pub reward_account: Box<Account<'info, TokenAccount>>,

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
    let reward_mint = ctx.accounts.reward_mint.key();
    let rate = verify_rate_attestation(
        &ctx.accounts.instructions.to_account_info(),
        &ctx.accounts.pool.attestor,
        &reward_mint,
        now,
    )?;

    let pool = &mut ctx.accounts.pool;
    let account = &mut ctx.accounts.operator_account;
    if account.owner == Pubkey::default() {
        account.owner = operator;
        account.bump = ctx.bumps.operator_account;
    }
    account.consume_nonce(nonce)?;
    require!(!account.overdue, RewardFloatError::OperatorOverdue);
    require!(
        account.open_loans < MAX_OPEN_LOANS,
        RewardFloatError::TooManyOpenLoans
    );
    let (accrued, reward_ceiling) = accrue_open_loans(
        ctx.remaining_accounts,
        &operator,
        pool,
        account.open_loans,
        &reward_mint,
        now,
    )?;
    account.total_debt = account
        .total_debt
        .checked_add(accrued)
        .and_then(|debt| debt.checked_add(amount))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    require!(
        account.total_debt <= attestation.limit,
        RewardFloatError::CreditLimitExceeded
    );
    account.open_loans = account
        .open_loans
        .checked_add(1)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    pool.accrued_interest = pool
        .accrued_interest
        .checked_add(accrued)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
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
    let loan_bump = ctx.bumps.loan;
    create_loan_account(
        &ctx.accounts.operator,
        &ctx.accounts.loan,
        &ctx.accounts.system_program,
        &[
            LOAN_SEED,
            operator.as_ref(),
            &nonce.to_le_bytes(),
            &[loan_bump],
        ],
    )?;
    let loan = Loan {
        operator,
        pool: pool.key(),
        reward_mint,
        nonce,
        principal: amount,
        outstanding: amount,
        accrued_interest: 0,
        interest_remainder: 0,
        opened_at: now,
        due_at,
        last_accrual_at: now,
        apr_bps,
        sweep_bps,
        status: LoanStatus::Active,
        bump: loan_bump,
    };
    pool.track(&loan)?;
    loan.try_serialize(&mut &mut ctx.accounts.loan.try_borrow_mut_data()?[..])?;

    // FR-014a by construction: the allowance is the debt of every open loan repaid from
    // this token, each at the rate it was actually issued at, converted at the attested
    // rate and rounded down. One account has one delegate, so it covers them all.
    let ceiling = reward_ceiling
        .checked_add(loan.debt_ceiling(now)?)
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    let allowance = u64::try_from(
        u128::from(ceiling) * RATE_UNIT / u128::from(rate.stable_per_trillion_reward),
    )
    .map_err(|_| error!(RewardFloatError::MathOverflow))?;
    require!(allowance > 0, RewardFloatError::DelegationTooSmall);
    // The operator signs borrow, and the signature carries into the call: the same one
    // approval the operator would otherwise give the token program directly.
    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Approve {
                to: ctx.accounts.reward_account.to_account_info(),
                delegate: ctx.accounts.operator_account.to_account_info(),
                authority: ctx.accounts.operator.to_account_info(),
            },
        ),
        allowance,
    )?;

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

// FR-012 bounds the debt across every open loan, interest included, so each one is
// brought up to this second before the limit is checked. `open_loans` is what makes
// "every" checkable: as many distinct open loans of this operator as it counts.
// Loans of another pool are refused rather than skipped, since their interest belongs
// on that pool's books, which this transaction does not hold. Returns the interest booked
// and the debt ceiling of the loans repaid from `reward_mint`.
fn accrue_open_loans(
    loans: &[AccountInfo],
    operator: &Pubkey,
    pool: &mut Account<Pool>,
    open_loans: u32,
    reward_mint: &Pubkey,
    now: i64,
) -> Result<(u64, u64)> {
    let pool_key = pool.key();
    require!(
        loans.len() == open_loans as usize,
        RewardFloatError::OpenLoansMismatch
    );
    let mut accrued: u64 = 0;
    let mut ceiling: u64 = 0;
    for (index, info) in loans.iter().enumerate() {
        require!(
            info.is_writable
                && *info.owner == crate::ID
                && !loans[..index].iter().any(|seen| seen.key == info.key),
            RewardFloatError::OpenLoansMismatch
        );
        let mut data = info.try_borrow_mut_data()?;
        let mut loan = Loan::try_deserialize(&mut &data[..])
            .map_err(|_| error!(RewardFloatError::OpenLoansMismatch))?;
        require!(
            loan.operator == *operator && loan.pool == pool_key && loan.is_open(),
            RewardFloatError::OpenLoansMismatch
        );
        pool.untrack(&loan)?;
        accrued = accrued
            .checked_add(loan.accrue(now)?)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        pool.track(&loan)?;
        if loan.reward_mint == *reward_mint {
            ceiling = ceiling
                .checked_add(loan.debt_ceiling(now)?)
                .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        }
        loan.try_serialize(&mut &mut data[..])?;
    }
    Ok((accrued, ceiling))
}

// What Anchor's `init` does, moved behind the nonce check. The address is known in
// advance, so lamports someone sent there beforehand are topped up and taken over
// rather than letting them block the loan. An account that already holds data is
// refused by the System Program, which keeps the loan address a second lock.
fn create_loan_account<'info>(
    payer: &Signer<'info>,
    loan: &UncheckedAccount<'info>,
    system: &Program<'info, System>,
    seeds: &[&[u8]],
) -> Result<()> {
    let space = 8 + Loan::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let signer = &[seeds];
    let held = loan.lamports();
    if held == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(
                system.to_account_info(),
                CreateAccount {
                    from: payer.to_account_info(),
                    to: loan.to_account_info(),
                },
                signer,
            ),
            rent,
            space as u64,
            &crate::ID,
        );
    }

    if held < rent {
        system_program::transfer(
            CpiContext::new(
                system.to_account_info(),
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: loan.to_account_info(),
                },
            ),
            rent - held,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            system.to_account_info(),
            Allocate {
                account_to_allocate: loan.to_account_info(),
            },
            signer,
        ),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.to_account_info(),
            Assign {
                account_to_assign: loan.to_account_info(),
            },
            signer,
        ),
        &crate::ID,
    )
}
