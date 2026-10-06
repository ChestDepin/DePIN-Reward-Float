// The sweep of FR-015: part of a payout that reached the operator's reward account is
// withheld, sold to the conversion vault and paid into the pool against the operator's
// loans, all in one instruction. Anyone may run it, the keeper included, and gain nothing
// by it: the payout is measured against the reward watch, the rate is the attestor's.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_ID;

use crate::error::RewardFloatError;
use crate::instructions::repay::settle;
use crate::instructions::verify_attestation::verify_rate_attestation;
use crate::slippage::check_conversion;
use crate::state::{
    ConversionVault, Loan, OperatorAccount, Pool, RewardWatch, CONVERSION_SEED, OPERATOR_SEED,
    WATCH_SEED,
};

const BPS: u128 = 10_000;

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(mut, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,

    // The delegate of the reward account: the withheld tokens leave it under this PDA's
    // signature, within the allowance the operator approved in borrow (FR-014).
    #[account(
        mut,
        seeds = [OPERATOR_SEED, operator_account.owner.as_ref()],
        bump = operator_account.bump,
    )]
    pub operator_account: Box<Account<'info, OperatorAccount>>,

    // The account borrow approved, and the only one the watch has a balance for.
    #[account(
        mut,
        address = get_associated_token_address(&operator_account.owner, &conversion_vault.reward_mint),
    )]
    pub reward_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [WATCH_SEED, operator_account.owner.as_ref(), conversion_vault.reward_mint.as_ref()],
        bump = reward_watch.bump,
    )]
    pub reward_watch: Box<Account<'info, RewardWatch>>,

    #[account(has_one = pool, has_one = stable_vault, has_one = reward_vault)]
    pub conversion_vault: Box<Account<'info, ConversionVault>>,

    #[account(mut)]
    pub stable_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: pinned to the instructions sysvar, and only read through its helpers.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// One loan withheld for, oldest first: its agreed share of every payout and how many
/// reward units would pay off what it owes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim {
    pub sweep_bps: u16,
    pub need: u64,
}

/// Reward units withheld for each claim out of one `payout`, within `allowance`.
///
/// Each loan takes its own agreed share of the whole payout (FR-015), never more than pays
/// it off; the shares the operator agreed to across loans may add up to more than the
/// payout, and then the older loans come first.
pub fn withholdings(payout: u64, allowance: u64, claims: &[Claim]) -> Vec<u64> {
    let mut left = payout.min(allowance);
    claims
        .iter()
        .map(|claim| {
            // At most the payout, which is a u64.
            let share = (u128::from(payout) * u128::from(claim.sweep_bps) / BPS) as u64;
            let take = share.min(claim.need).min(left);
            left -= take;
            take
        })
        .collect()
}

/// A withholding that went through, one per loan it repaid (FR-016).
#[event]
pub struct Swept {
    pub loan: Pubkey,
    pub operator: Pubkey,
    pub reward_mint: Pubkey,
    pub withheld: u64,
    pub paid: u64,
    pub stable_per_trillion_reward: u64,
    // Of the whole conversion in this sweep, which is what the tolerance was checked on.
    pub deviation_bps: u16,
    pub remaining_debt: u64,
}

/// A payout left untouched because the market fell outside the tolerance (FR-015a). The
/// reason stays on chain for the operator to see, and the payout for a later sweep.
#[event]
pub struct SweepSkipped {
    pub operator: Pubkey,
    pub reward_mint: Pubkey,
    pub withheld: u64,
    pub stable_per_trillion_reward: u64,
    pub deviation_bps: u16,
    pub max_slippage_bps: u16,
}

pub fn handle_sweep(ctx: Context<Sweep>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let reward_mint = ctx.accounts.conversion_vault.reward_mint;
    let rate = verify_rate_attestation(
        &ctx.accounts.instructions.to_account_info(),
        &ctx.accounts.pool.attestor,
        &reward_mint,
        now,
        1,
    )?
    .stable_per_trillion_reward;

    let operator = ctx.accounts.operator_account.owner;
    let balance = ctx.accounts.reward_account.amount;
    let payout = balance.saturating_sub(ctx.accounts.reward_watch.balance);
    let allowance = match ctx.accounts.reward_account.delegate {
        COption::Some(delegate) if delegate == ctx.accounts.operator_account.key() => {
            ctx.accounts.reward_account.delegated_amount
        }
        _ => 0,
    };
    let mut loans = open_loans_of(
        ctx.remaining_accounts,
        &operator,
        &ctx.accounts.pool.key(),
        ctx.accounts.operator_account.open_loans,
        &reward_mint,
    )?;

    let conversion = &ctx.accounts.conversion_vault;
    let mut owed = Vec::with_capacity(loans.len());
    let mut claims = Vec::with_capacity(loans.len());
    for (_, loan) in &loans {
        let mut accrued = loan.clone();
        accrued.accrue(now)?;
        let debt = accrued.total_owed()?;
        claims.push(Claim {
            sweep_bps: loan.sweep_bps,
            need: conversion.tokens_for(debt, rate),
        });
        owed.push(debt);
    }
    let mut withheld = withholdings(payout, allowance, &claims);
    let mut paid = Vec::with_capacity(loans.len());
    for (take, debt) in withheld.iter_mut().zip(&owed) {
        let pays = conversion.quote(*take, rate)?.min(*debt);
        // Tokens that would sell for nothing stay with the operator.
        if pays == 0 {
            *take = 0;
        }
        paid.push(pays);
    }
    // Each part is at most the payout, and there are at most MAX_OPEN_LOANS parts.
    let total_withheld = withheld
        .iter()
        .try_fold(0u64, |sum, take| sum.checked_add(*take))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    if total_withheld == 0 {
        // Below the watch means tokens were moved out; the next payout is measured from here.
        ctx.accounts.reward_watch.balance = balance;
        return Ok(());
    }
    let total_paid = paid
        .iter()
        .try_fold(0u64, |sum, pays| sum.checked_add(*pays))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    // Checked on what the loans are credited with, not on what the vault quoted: a quote
    // above the debt pays nobody the excess.
    let check = check_conversion(
        total_withheld,
        rate,
        total_paid,
        conversion.max_slippage_bps,
    )?;
    if !check.within_tolerance {
        emit!(SweepSkipped {
            operator,
            reward_mint,
            withheld: total_withheld,
            stable_per_trillion_reward: rate,
            deviation_bps: check.deviation_bps,
            max_slippage_bps: conversion.max_slippage_bps,
        });
        return Ok(());
    }

    let operator_seeds: &[&[u8]] = &[
        OPERATOR_SEED,
        operator.as_ref(),
        &[ctx.accounts.operator_account.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reward_account.to_account_info(),
                to: ctx.accounts.reward_vault.to_account_info(),
                authority: ctx.accounts.operator_account.to_account_info(),
            },
            &[operator_seeds],
        ),
        total_withheld,
    )?;
    let pool_key = ctx.accounts.pool.key();
    let conversion_seeds: &[&[u8]] = &[
        CONVERSION_SEED,
        pool_key.as_ref(),
        reward_mint.as_ref(),
        &[conversion.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.stable_vault.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: conversion.to_account_info(),
            },
            &[conversion_seeds],
        ),
        total_paid,
    )?;

    for (((index, loan), take), pays) in loans.iter_mut().zip(&withheld).zip(&paid) {
        if *pays == 0 {
            continue;
        }
        settle(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.operator_account,
            loan,
            now,
            *pays,
        )?;
        let info = &ctx.remaining_accounts[*index];
        loan.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        emit!(Swept {
            loan: info.key(),
            operator,
            reward_mint,
            withheld: *take,
            paid: *pays,
            stable_per_trillion_reward: rate,
            deviation_bps: check.deviation_bps,
            remaining_debt: loan.total_owed()?,
        });
    }
    ctx.accounts.reward_watch.balance = balance - total_withheld;
    Ok(())
}

// Every open loan of the operator in this pool, as borrow takes them: were one allowed to be
// left out, the caller would pick which loans a payout goes to. Returns the ones repaid from
// `reward_mint`, oldest first, each with its place among the accounts.
fn open_loans_of(
    loans: &[AccountInfo],
    operator: &Pubkey,
    pool: &Pubkey,
    open_loans: u32,
    reward_mint: &Pubkey,
) -> Result<Vec<(usize, Loan)>> {
    require!(
        loans.len() == open_loans as usize,
        RewardFloatError::OpenLoansMismatch
    );
    let mut found = Vec::new();
    for (index, info) in loans.iter().enumerate() {
        require!(
            info.is_writable
                && *info.owner == crate::ID
                && !loans[..index].iter().any(|seen| seen.key == info.key),
            RewardFloatError::OpenLoansMismatch
        );
        let loan = Loan::try_deserialize(&mut &info.try_borrow_data()?[..])
            .map_err(|_| error!(RewardFloatError::OpenLoansMismatch))?;
        require!(
            loan.operator == *operator && loan.pool == *pool && loan.is_open(),
            RewardFloatError::OpenLoansMismatch
        );
        if loan.reward_mint == *reward_mint {
            found.push((index, loan));
        }
    }
    found.sort_by_key(|(_, loan)| (loan.opened_at, loan.nonce));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values worked out by hand: floor(payout · bps / 10 000), then the smallest of
    // that, the need and what is left of the payout within the allowance.
    fn claim(sweep_bps: u16, need: u64) -> Claim {
        Claim { sweep_bps, need }
    }

    #[test]
    fn a_loan_takes_its_share_of_the_payout() {
        assert_eq!(
            withholdings(1_000, u64::MAX, &[claim(5_000, 1_000_000)]),
            [500]
        );
    }

    #[test]
    fn a_loan_owing_less_than_its_share_takes_only_what_pays_it_off() {
        assert_eq!(withholdings(1_000, u64::MAX, &[claim(5_000, 120)]), [120]);
    }

    #[test]
    fn each_loan_takes_its_share_of_the_same_payout() {
        assert_eq!(
            withholdings(1_000, u64::MAX, &[claim(3_000, 1_000), claim(2_000, 1_000)]),
            [300, 200]
        );
    }

    #[test]
    fn shares_adding_up_past_the_payout_leave_the_newest_loan_the_rest() {
        assert_eq!(
            withholdings(1_000, u64::MAX, &[claim(6_000, 1_000), claim(6_000, 1_000)]),
            [600, 400]
        );
    }

    #[test]
    fn a_loan_paid_off_first_leaves_its_share_with_the_operator() {
        assert_eq!(
            withholdings(1_000, u64::MAX, &[claim(6_000, 100), claim(6_000, 1_000)]),
            [100, 600]
        );
    }

    #[test]
    fn nothing_is_withheld_past_the_allowance() {
        assert_eq!(
            withholdings(1_000, 300, &[claim(5_000, 1_000), claim(5_000, 1_000)]),
            [300, 0]
        );
        assert_eq!(withholdings(1_000, 0, &[claim(5_000, 1_000)]), [0]);
    }

    #[test]
    fn a_share_rounds_down_in_the_operator_s_favour() {
        assert_eq!(withholdings(3, u64::MAX, &[claim(5_000, 10)]), [1]);
        assert_eq!(withholdings(1, u64::MAX, &[claim(9_999, 10)]), [0]);
    }

    #[test]
    fn no_payout_withholds_nothing() {
        assert_eq!(
            withholdings(0, u64::MAX, &[claim(10_000, 1_000), claim(5_000, 1_000)]),
            [0, 0]
        );
    }

    #[test]
    fn the_largest_payout_takes_its_whole_share_without_overflow() {
        assert_eq!(
            withholdings(u64::MAX, u64::MAX, &[claim(10_000, u64::MAX)]),
            [u64::MAX]
        );
    }
}
