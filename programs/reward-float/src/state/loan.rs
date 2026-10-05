// One loan. Everything about it is fixed at issue time (FR-009): the rate does not
// move with pool utilisation, and the schedule does not move at all.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

/// Seed prefix of the loan PDA: `["loan", operator, nonce]`.
pub const LOAN_SEED: &[u8] = b"loan";

/// One repayment period. A loan is repaid in equal instalments of principal, one per
/// period, and its term is a whole number of them.
pub const REPAYMENT_PERIOD: i64 = 30 * 24 * 60 * 60;

/// Longest term a loan can be issued for, in periods.
///
/// A credit limit is at most two months of an operator's reward flow, so with half of
/// every payout withheld a loan at the limit is repaid in about four periods. Six leave
/// room for a thinner month without reaching further out than past payouts are trusted
/// to predict future ones.
pub const MAX_TERM_PERIODS: u8 = 6;

/// The year an annual rate is quoted over.
pub const SECONDS_PER_YEAR: i64 = 365 * 24 * 60 * 60;

// Interest for `dt` seconds is `outstanding · apr_bps · dt / ACCRUAL_DENOMINATOR`.
pub(crate) const ACCRUAL_DENOMINATOR: u128 = 10_000 * SECONDS_PER_YEAR as u128;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LoanStatus {
    Active,
    // Past the overdue threshold (FR-021). Still owes money; the operator's limit is
    // zeroed, and nothing of theirs is seized — the loan is unsecured by design.
    Overdue,
    // Paid off in full. The account is kept rather than closed, so the nonce that seeded
    // its address can never be used to open a second loan from the same attestation.
    Repaid,
}

#[account]
#[derive(InitSpace)]
pub struct Loan {
    pub operator: Pubkey,
    pub pool: Pubkey,
    // Reward token this loan is repaid from when a sweep runs (FR-015).
    pub reward_mint: Pubkey,
    // Nonce of the attestation this loan was issued against. It seeds the address, so
    // it is stored to make the address derivable from the account alone.
    pub nonce: u64,
    pub principal: u64,
    // Principal not yet repaid.
    pub outstanding: u64,
    // Interest accrued and not yet repaid.
    pub accrued_interest: u64,
    // Fraction of a base unit of interest accrued but not yet booked, as a numerator over
    // ACCRUAL_DENOMINATOR. Carrying it makes the total independent of how often accrual
    // runs, and anyone can make it run by repaying a single unit.
    pub interest_remainder: u64,
    pub opened_at: i64,
    pub due_at: i64,
    // When interest was last brought up to date. Accrual is a function of the gap
    // between this and now, so it has to be part of the state, not of a log.
    pub last_accrual_at: i64,
    // Annual rate in basis points, frozen at issue time.
    pub apr_bps: u16,
    // Share of an incoming reward payout withheld towards this loan (FR-015).
    pub sweep_bps: u16,
    pub status: LoanStatus,
    pub bump: u8,
}

impl Loan {
    /// What the operator owes on this loan right now, as far as the state knows.
    pub fn total_owed(&self) -> Result<u64> {
        self.outstanding
            .checked_add(self.accrued_interest)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))
    }

    /// Principal the schedule fixed at issue expects to be repaid by `at` (FR-009): one
    /// equal instalment per period that has fully passed, all of it once the term is over.
    ///
    /// Nothing is stored per instalment. The schedule follows from the principal and the
    /// two dates, so a partial repayment moves the operator along it without rewriting it.
    pub fn principal_due_by(&self, at: i64) -> u64 {
        let periods = (self.due_at - self.opened_at) / REPAYMENT_PERIOD;
        if periods <= 0 {
            return self.principal;
        }
        let passed = (at.saturating_sub(self.opened_at) / REPAYMENT_PERIOD).clamp(0, periods);
        // Never more than the principal, since `passed` is clamped to `periods`.
        ((u128::from(self.principal) * passed as u128).div_ceil(periods as u128)) as u64
    }

    /// Whether this loan still counts towards the operator's debt.
    pub fn is_open(&self) -> bool {
        !matches!(self.status, LoanStatus::Repaid)
    }

    /// Brings interest up to `now` at the rate fixed at issue (FR-009) and returns what
    /// was added, for the operator's and the pool's books to follow.
    ///
    /// Simple interest on the principal still outstanding. It keeps running past the end
    /// of the term and while overdue, at the same rate: FR-009 fixes the rate until the
    /// loan is closed, and FR-021 rules out any other consequence of being late.
    pub fn accrue(&mut self, now: i64) -> Result<u64> {
        if now <= self.last_accrual_at {
            return Ok(0);
        }
        let elapsed = (now - self.last_accrual_at) as u128;
        let numerator = u128::from(self.outstanding)
            .checked_mul(u128::from(self.apr_bps))
            .and_then(|per_second| per_second.checked_mul(elapsed))
            .and_then(|accrued| accrued.checked_add(u128::from(self.interest_remainder)))
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        let interest = u64::try_from(numerator / ACCRUAL_DENOMINATOR)
            .map_err(|_| error!(RewardFloatError::MathOverflow))?;
        self.accrued_interest = self
            .accrued_interest
            .checked_add(interest)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        // Below ACCRUAL_DENOMINATOR, which is about 3 · 10^11 and fits u64 easily.
        self.interest_remainder = (numerator % ACCRUAL_DENOMINATOR) as u64;
        self.last_accrual_at = now;
        Ok(interest)
    }

    /// This loan's part of the pool's accrual sums (FR-018): its rate, its rate times the
    /// moment its interest was last booked, and its unbooked fraction. Only the first two
    /// move with time, and only on accrual, which is why the pool can carry them as sums.
    pub fn accrual_terms(&self) -> Result<AccrualTerms> {
        let rate = u128::from(self.outstanding) * u128::from(self.apr_bps);
        let rate_time = u128::try_from(self.last_accrual_at)
            .ok()
            .and_then(|at| rate.checked_mul(at))
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        Ok(AccrualTerms {
            rate,
            rate_time,
            remainder: u128::from(self.interest_remainder),
        })
    }

    /// Takes a repayment of at most `max_amount` (FR-011) and says how it was split.
    ///
    /// `max_amount` is a ceiling, not a demand: once interest accrues by the second, the
    /// exact debt at the moment the transaction lands cannot be known when it is signed,
    /// so the excess is simply not taken rather than refused. Interest is settled before
    /// principal, so the pool's receivable turns into cash first.
    pub fn apply_repayment(&mut self, max_amount: u64) -> Result<Repayment> {
        require!(self.is_open(), RewardFloatError::LoanNotOpen);
        require!(max_amount > 0, RewardFloatError::InvalidAmount);
        let paid = max_amount.min(self.total_owed()?);
        let interest = paid.min(self.accrued_interest);
        let principal = paid - interest;
        self.accrued_interest -= interest;
        self.outstanding -= principal;
        if self.outstanding == 0 && self.accrued_interest == 0 {
            self.status = LoanStatus::Repaid;
        }
        Ok(Repayment {
            interest,
            principal,
        })
    }
}

/// One loan's part of [`crate::Pool`]'s accrual sums.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AccrualTerms {
    pub rate: u128,
    pub rate_time: u128,
    pub remainder: u128,
}

/// How one repayment was split between interest and principal.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Repayment {
    pub interest: u64,
    pub principal: u64,
}

impl Repayment {
    pub fn total(&self) -> u64 {
        // Both halves were taken out of one `total_owed`, which did not overflow.
        self.interest + self.principal
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RewardFloatError;

    fn code(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    fn loan() -> Loan {
        Loan {
            operator: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            reward_mint: Pubkey::new_unique(),
            nonce: 1,
            principal: 1_000_000,
            outstanding: 1_000_000,
            accrued_interest: 0,
            interest_remainder: 0,
            opened_at: 1_700_000_000,
            due_at: 1_700_000_000 + 30 * 86_400,
            last_accrual_at: 1_700_000_000,
            apr_bps: 1_800,
            sweep_bps: 5_000,
            status: LoanStatus::Active,
            bump: 252,
        }
    }

    #[test]
    fn what_is_owed_is_principal_left_plus_interest_accrued() {
        let mut loan = loan();
        loan.outstanding = 600_000;
        loan.accrued_interest = 17_500;
        assert_eq!(loan.total_owed().unwrap(), 617_500);
    }

    #[test]
    fn what_is_owed_fails_loud_instead_of_wrapping() {
        let mut loan = loan();
        loan.outstanding = u64::MAX;
        loan.accrued_interest = 1;
        let err = loan.total_owed().unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    #[test]
    fn an_active_loan_is_open_and_a_repaid_one_is_not() {
        let mut loan = loan();
        assert!(loan.is_open());
        loan.status = LoanStatus::Overdue;
        assert!(loan.is_open(), "an overdue loan still owes money");
        loan.status = LoanStatus::Repaid;
        assert!(!loan.is_open());
    }

    fn three_period_loan() -> Loan {
        let mut loan = loan();
        loan.principal = 1_000_000;
        loan.due_at = loan.opened_at + 3 * REPAYMENT_PERIOD;
        loan
    }

    #[test]
    fn nothing_is_due_before_the_first_period_is_over() {
        let loan = three_period_loan();
        assert_eq!(loan.principal_due_by(loan.opened_at - 1), 0);
        assert_eq!(loan.principal_due_by(loan.opened_at), 0);
        assert_eq!(
            loan.principal_due_by(loan.opened_at + REPAYMENT_PERIOD - 1),
            0
        );
    }

    #[test]
    fn each_period_that_passes_makes_one_instalment_due_rounded_up() {
        let loan = three_period_loan();
        assert_eq!(
            loan.principal_due_by(loan.opened_at + REPAYMENT_PERIOD),
            333_334
        );
        assert_eq!(
            loan.principal_due_by(loan.opened_at + 2 * REPAYMENT_PERIOD),
            666_667
        );
    }

    #[test]
    fn all_of_the_principal_is_due_at_the_end_of_the_term_and_after() {
        let loan = three_period_loan();
        assert_eq!(loan.principal_due_by(loan.due_at), 1_000_000);
        assert_eq!(loan.principal_due_by(i64::MAX), 1_000_000);
    }

    #[test]
    fn a_one_period_loan_is_due_in_one_piece() {
        let mut loan = three_period_loan();
        loan.principal = u64::MAX;
        loan.due_at = loan.opened_at + REPAYMENT_PERIOD;
        assert_eq!(loan.principal_due_by(loan.due_at - 1), 0);
        assert_eq!(loan.principal_due_by(loan.due_at), u64::MAX);
    }

    fn owing(outstanding: u64, accrued_interest: u64) -> Loan {
        let mut loan = loan();
        loan.outstanding = outstanding;
        loan.accrued_interest = accrued_interest;
        loan
    }

    #[test]
    fn a_repayment_settles_interest_before_principal() {
        let mut loan = owing(600_000, 20_000);
        let paid = loan.apply_repayment(100_000).unwrap();
        assert_eq!(
            paid,
            Repayment {
                interest: 20_000,
                principal: 80_000
            }
        );
        assert_eq!(loan.accrued_interest, 0);
        assert_eq!(loan.outstanding, 520_000);
        assert_eq!(loan.status, LoanStatus::Active);
    }

    #[test]
    fn a_repayment_smaller_than_the_interest_leaves_the_principal_alone() {
        let mut loan = owing(600_000, 20_000);
        let paid = loan.apply_repayment(5_000).unwrap();
        assert_eq!(
            paid,
            Repayment {
                interest: 5_000,
                principal: 0
            }
        );
        assert_eq!(loan.accrued_interest, 15_000);
        assert_eq!(loan.outstanding, 600_000);
    }

    #[test]
    fn exactly_the_debt_repays_the_loan() {
        let mut loan = owing(600_000, 20_000);
        let paid = loan.apply_repayment(620_000).unwrap();
        assert_eq!(paid.total(), 620_000);
        assert_eq!((loan.outstanding, loan.accrued_interest), (0, 0));
        assert_eq!(loan.status, LoanStatus::Repaid);
    }

    #[test]
    fn more_than_the_debt_takes_only_the_debt() {
        let mut loan = owing(600_000, 20_000);
        let paid = loan.apply_repayment(u64::MAX).unwrap();
        assert_eq!(
            paid,
            Repayment {
                interest: 20_000,
                principal: 600_000
            }
        );
        assert_eq!(loan.status, LoanStatus::Repaid);
    }

    #[test]
    fn an_overdue_loan_can_still_be_repaid() {
        let mut loan = owing(600_000, 0);
        loan.status = LoanStatus::Overdue;
        assert_eq!(loan.apply_repayment(1).unwrap().principal, 1);
        assert_eq!(loan.status, LoanStatus::Overdue);
        loan.apply_repayment(u64::MAX).unwrap();
        assert_eq!(loan.status, LoanStatus::Repaid);
    }

    #[test]
    fn a_repayment_of_nothing_is_refused() {
        let mut loan = owing(600_000, 20_000);
        let err = loan.apply_repayment(0).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::InvalidAmount)));
        assert_eq!((loan.outstanding, loan.accrued_interest), (600_000, 20_000));
    }

    #[test]
    fn a_repaid_loan_takes_no_more_money() {
        let mut loan = owing(0, 0);
        loan.status = LoanStatus::Repaid;
        let err = loan.apply_repayment(1).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::LoanNotOpen)));
    }

    #[test]
    fn what_is_owed_overflowing_fails_loud_on_repayment_too() {
        let mut loan = owing(u64::MAX, 1);
        let err = loan.apply_repayment(1).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    const T0: i64 = 1_700_000_000;

    fn accruing(outstanding: u64, apr_bps: u16) -> Loan {
        let mut loan = owing(outstanding, 0);
        loan.apr_bps = apr_bps;
        loan.last_accrual_at = T0;
        loan
    }

    #[test]
    fn a_year_accrues_the_annual_rate_on_what_is_outstanding() {
        let mut loan = accruing(1_000_000_000, 1_000);
        assert_eq!(loan.accrue(T0 + SECONDS_PER_YEAR).unwrap(), 100_000_000);
        assert_eq!(loan.accrued_interest, 100_000_000);
        assert_eq!(loan.interest_remainder, 0);
        assert_eq!(loan.last_accrual_at, T0 + SECONDS_PER_YEAR);
    }

    #[test]
    fn a_fraction_of_a_unit_is_carried_rather_than_lost() {
        // 100 USDC at 10 % is about 0.317 base units a second.
        let mut loan = accruing(100_000_000, 1_000);
        assert_eq!(loan.accrue(T0 + 1).unwrap(), 0);
        assert_eq!(loan.interest_remainder, 100_000_000 * 1_000);
        assert_eq!(loan.accrue(T0 + 3).unwrap(), 0);
        assert_eq!(loan.accrue(T0 + 4).unwrap(), 1);
        assert_eq!(
            loan.interest_remainder,
            4 * 100_000_000 * 1_000 - 10_000 * SECONDS_PER_YEAR as u64
        );
    }

    #[test]
    fn how_often_accrual_runs_does_not_change_what_accrues() {
        let mut every_second = accruing(100_000_000, 1_000);
        let mut once = accruing(100_000_000, 1_000);
        let day = 86_400;
        for second in 1..=day {
            every_second.accrue(T0 + second).unwrap();
        }
        once.accrue(T0 + day).unwrap();
        assert_eq!(every_second.accrued_interest, once.accrued_interest);
        assert_eq!(every_second.interest_remainder, once.interest_remainder);
        assert_eq!(once.accrued_interest, 27_397);
    }

    #[test]
    fn interest_follows_the_principal_after_a_partial_repayment() {
        let mut loan = accruing(1_000_000_000, 1_000);
        loan.accrue(T0 + SECONDS_PER_YEAR / 2).unwrap();
        loan.apply_repayment(550_000_000).unwrap();
        assert_eq!((loan.outstanding, loan.accrued_interest), (500_000_000, 0));
        assert_eq!(loan.accrue(T0 + SECONDS_PER_YEAR).unwrap(), 25_000_000);
    }

    #[test]
    fn interest_keeps_running_past_the_term_and_while_overdue() {
        let mut loan = accruing(1_000_000_000, 1_000);
        loan.due_at = T0 + REPAYMENT_PERIOD;
        loan.status = LoanStatus::Overdue;
        assert_eq!(loan.accrue(T0 + SECONDS_PER_YEAR).unwrap(), 100_000_000);
    }

    #[test]
    fn nothing_accrues_on_nothing_outstanding() {
        let mut loan = accruing(0, 1_000);
        loan.status = LoanStatus::Repaid;
        assert_eq!(loan.accrue(T0 + SECONDS_PER_YEAR).unwrap(), 0);
        assert_eq!(loan.accrued_interest, 0);
    }

    #[test]
    fn a_clock_behind_the_last_accrual_accrues_nothing_and_moves_nothing() {
        let mut loan = accruing(1_000_000_000, 1_000);
        assert_eq!(loan.accrue(T0 - 60).unwrap(), 0);
        assert_eq!(loan.last_accrual_at, T0);
        assert_eq!(loan.interest_remainder, 0);
    }

    #[test]
    fn accrual_fails_loud_instead_of_wrapping() {
        let mut loan = accruing(u64::MAX, u16::MAX);
        let err = loan.accrue(i64::MAX).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));

        let mut loan = accruing(1, 1);
        loan.accrued_interest = u64::MAX;
        let err = loan
            .accrue(T0 + 10 * SECONDS_PER_YEAR * 10_000)
            .unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // operator 32 + pool 32 + reward_mint 32 + nonce 8 + principal 8
        // + outstanding 8 + accrued_interest 8 + interest_remainder 8 + opened_at 8
        // + due_at 8 + last_accrual_at 8 + apr_bps 2 + sweep_bps 2 + status 1 + bump 1
        assert_eq!(Loan::INIT_SPACE, 166);
    }
}
