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
    ConversionVault, Loan, ManualReason, OperatorAccount, Pool, RewardWatch, CONVERSION_SEED,
    OPERATOR_SEED, WATCH_SEED,
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

/// One loan withheld for, oldest first: its agreed share of every payout, how many reward
/// units would pay off what it owes, and what earlier payouts still owe it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim {
    pub sweep_bps: u16,
    pub need: u64,
    pub due: u64,
}

/// What one loan is owed out of a sweep, and how much of it the account can give.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Withholding {
    pub owed: u64,
    pub take: u64,
}

/// Reward units owed to each claim out of one `payout`, and taken within `available`.
///
/// Each loan is owed what earlier payouts left unpaid and its own agreed share of the whole
/// new payout (FR-015), never more than pays it off; the shares the operator agreed to
/// across loans may add up to more than the payout, and then the older loans come first.
pub fn withholdings(payout: u64, available: u64, claims: &[Claim]) -> Vec<Withholding> {
    let mut payout_left = payout;
    let mut left = available;
    claims
        .iter()
        .map(|claim| {
            let earlier = claim.due.min(claim.need);
            // At most the payout, which is a u64.
            let share = (u128::from(payout) * u128::from(claim.sweep_bps) / BPS) as u64;
            let fresh = share.min(claim.need - earlier).min(payout_left);
            payout_left -= fresh;
            // Both parts together are at most the need.
            let owed = earlier + fresh;
            let take = owed.min(left);
            left -= take;
            Withholding { owed, take }
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

/// A loan its payouts stopped repaying, and why (FR-017). Emitted when the loan is flagged,
/// not on every sweep that finds it still flagged.
#[event]
pub struct ManualRepaymentNeeded {
    pub loan: Pubkey,
    pub operator: Pubkey,
    pub reward_mint: Pubkey,
    pub reason: ManualReason,
    pub reward_due: u64,
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
    let ours =
        ctx.accounts.reward_account.delegate == COption::Some(ctx.accounts.operator_account.key());
    let allowance = if ours {
        ctx.accounts.reward_account.delegated_amount
    } else {
        0
    };
    // Whatever a loan is owed and cannot be given, it is the allowance or the tokens that ran
    // out. Owed tokens were on the account when a sweep counted them, so with the allowance
    // covering the balance, a shortfall means they left it (FR-017).
    let shortfall = if !ours {
        ManualReason::Revoked
    } else if allowance < balance {
        ManualReason::AllowanceShort
    } else {
        ManualReason::WithdrawnEarly
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
            due: loan.reward_due,
        });
        owed.push(debt);
    }
    let plan = withholdings(payout, balance.min(allowance), &claims);
    let mut withheld = Vec::with_capacity(loans.len());
    let mut paid = Vec::with_capacity(loans.len());
    let mut flagged = vec![false; loans.len()];
    for (index, ((_, loan), part)) in loans.iter_mut().zip(&plan).enumerate() {
        let pays = conversion.quote(part.take, rate)?.min(owed[index]);
        // Tokens that would sell for nothing stay with the operator, and are not owed either.
        withheld.push(if pays == 0 { 0 } else { part.take });
        paid.push(pays);
        loan.reward_due = part.owed - part.take;
        if part.take < part.owed {
            flagged[index] = loan.flag_manual_repayment(shortfall);
        }
    }
    // Each part is within what the account could give, which is a u64.
    let total_withheld = withheld
        .iter()
        .try_fold(0u64, |sum, take| sum.checked_add(*take))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
    let total_paid = paid
        .iter()
        .try_fold(0u64, |sum, pays| sum.checked_add(*pays))
        .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;

    // The watch moves to the balance whatever happens: what loans are owed is kept on them,
    // so that tokens leaving the account below it can be told from tokens owed leaving it.
    let mut watch = balance;
    if total_withheld > 0 {
        // Checked on what the loans are credited with, not on what the vault quoted: a quote
        // above the debt pays nobody the excess.
        let check = check_conversion(
            total_withheld,
            rate,
            total_paid,
            conversion.max_slippage_bps,
        )?;
        if !check.within_tolerance {
            for ((_, loan), take) in loans.iter_mut().zip(&withheld) {
                // Back to what the loan was owed, which is a u64.
                loan.reward_due += take;
            }
            emit!(SweepSkipped {
                operator,
                reward_mint,
                withheld: total_withheld,
                stable_per_trillion_reward: rate,
                deviation_bps: check.deviation_bps,
                max_slippage_bps: conversion.max_slippage_bps,
            });
        } else {
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

            for (index, (slot, loan)) in loans.iter_mut().enumerate() {
                let (take, pays) = (withheld[index], paid[index]);
                if pays == 0 {
                    continue;
                }
                // The loan got all it was owed: its payouts repay it by themselves again.
                if take == plan[index].owed {
                    loan.manual_repayment = None;
                }
                settle(
                    &mut ctx.accounts.pool,
                    &mut ctx.accounts.operator_account,
                    loan,
                    now,
                    pays,
                )?;
                emit!(Swept {
                    loan: ctx.remaining_accounts[*slot].key(),
                    operator,
                    reward_mint,
                    withheld: take,
                    paid: pays,
                    stable_per_trillion_reward: rate,
                    deviation_bps: check.deviation_bps,
                    remaining_debt: loan.total_owed()?,
                });
            }
            // The token program drops a delegate whose allowance reaches zero, so a loan
            // still owing is left with nothing to be repaid from, and the next payout would
            // read as a revoked allowance.
            if ours && total_withheld == allowance {
                for (index, (_, loan)) in loans.iter_mut().enumerate() {
                    if loan.is_open() && loan.flag_manual_repayment(ManualReason::AllowanceShort) {
                        flagged[index] = true;
                    }
                }
            }
            watch = balance - total_withheld;
        }
    }
    ctx.accounts.reward_watch.balance = watch;

    for (index, (slot, loan)) in loans.iter().enumerate() {
        let info = &ctx.remaining_accounts[*slot];
        loan.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        if let (true, Some(reason)) = (flagged[index], loan.manual_repayment) {
            emit!(ManualRepaymentNeeded {
                loan: info.key(),
                operator,
                reward_mint,
                reason,
                reward_due: loan.reward_due,
            });
        }
    }
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

    // Expected values worked out by hand: floor(payout · bps / 10 000), capped by what pays
    // the loan off once what earlier payouts owe it is counted, and by what is left of the
    // payout; what is taken is that within what the account can give.
    fn claim(sweep_bps: u16, need: u64) -> Claim {
        Claim {
            sweep_bps,
            need,
            due: 0,
        }
    }

    fn owing(sweep_bps: u16, need: u64, due: u64) -> Claim {
        Claim {
            sweep_bps,
            need,
            due,
        }
    }

    fn takes(payout: u64, available: u64, claims: &[Claim]) -> Vec<u64> {
        withholdings(payout, available, claims)
            .iter()
            .map(|withholding| withholding.take)
            .collect()
    }

    fn owed(payout: u64, available: u64, claims: &[Claim]) -> Vec<u64> {
        withholdings(payout, available, claims)
            .iter()
            .map(|withholding| withholding.owed)
            .collect()
    }

    #[test]
    fn a_loan_takes_its_share_of_the_payout() {
        assert_eq!(takes(1_000, u64::MAX, &[claim(5_000, 1_000_000)]), [500]);
    }

    #[test]
    fn a_loan_owing_less_than_its_share_takes_only_what_pays_it_off() {
        assert_eq!(takes(1_000, u64::MAX, &[claim(5_000, 120)]), [120]);
    }

    #[test]
    fn each_loan_takes_its_share_of_the_same_payout() {
        assert_eq!(
            takes(1_000, u64::MAX, &[claim(3_000, 1_000), claim(2_000, 1_000)]),
            [300, 200]
        );
    }

    #[test]
    fn shares_adding_up_past_the_payout_leave_the_newest_loan_the_rest() {
        assert_eq!(
            takes(1_000, u64::MAX, &[claim(6_000, 1_000), claim(6_000, 1_000)]),
            [600, 400]
        );
    }

    #[test]
    fn a_loan_paid_off_first_leaves_its_share_with_the_operator() {
        assert_eq!(
            takes(1_000, u64::MAX, &[claim(6_000, 100), claim(6_000, 1_000)]),
            [100, 600]
        );
    }

    #[test]
    fn nothing_is_taken_past_what_the_account_can_give() {
        assert_eq!(
            takes(1_000, 300, &[claim(5_000, 1_000), claim(5_000, 1_000)]),
            [300, 0]
        );
        assert_eq!(takes(1_000, 0, &[claim(5_000, 1_000)]), [0]);
    }

    #[test]
    fn what_could_not_be_taken_is_still_owed() {
        assert_eq!(
            owed(1_000, 300, &[claim(5_000, 1_000), claim(5_000, 1_000)]),
            [500, 500]
        );
    }

    #[test]
    fn what_earlier_payouts_owe_comes_on_top_of_the_new_share() {
        assert_eq!(takes(1_000, u64::MAX, &[owing(5_000, 10_000, 300)]), [800]);
    }

    #[test]
    fn what_earlier_payouts_owe_is_taken_without_a_new_payout() {
        assert_eq!(takes(0, u64::MAX, &[owing(5_000, 10_000, 300)]), [300]);
    }

    #[test]
    fn what_earlier_payouts_owe_never_takes_more_than_pays_the_loan_off() {
        assert_eq!(owed(1_000, u64::MAX, &[owing(5_000, 200, 500)]), [200]);
    }

    #[test]
    fn only_the_new_shares_are_bounded_by_the_new_payout() {
        assert_eq!(
            owed(
                1_000,
                u64::MAX,
                &[owing(6_000, 10_000, 500), claim(6_000, 10_000)]
            ),
            [1_100, 400]
        );
    }

    #[test]
    fn a_share_rounds_down_in_the_operator_s_favour() {
        assert_eq!(takes(3, u64::MAX, &[claim(5_000, 10)]), [1]);
        assert_eq!(takes(1, u64::MAX, &[claim(9_999, 10)]), [0]);
    }

    #[test]
    fn no_payout_and_nothing_owed_withholds_nothing() {
        assert_eq!(
            takes(0, u64::MAX, &[claim(10_000, 1_000), claim(5_000, 1_000)]),
            [0, 0]
        );
    }

    #[test]
    fn the_largest_payout_takes_its_whole_share_without_overflow() {
        assert_eq!(
            takes(u64::MAX, u64::MAX, &[claim(10_000, u64::MAX)]),
            [u64::MAX]
        );
        assert_eq!(
            owed(u64::MAX, 0, &[owing(10_000, u64::MAX, u64::MAX)]),
            [u64::MAX]
        );
    }
}
