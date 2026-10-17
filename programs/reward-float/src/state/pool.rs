// The shared pot of stablecoin: what lenders put in, what operators took out, and
// the key that is allowed to vouch for an operator's credit limit.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;
use crate::state::{Loan, ACCRUAL_DENOMINATOR};

/// Seed prefix of the pool PDA: `["pool", stable_mint]`.
pub const POOL_SEED: &[u8] = b"pool";

/// Seed prefix of the vault token account PDA: `["vault", pool]`.
pub const VAULT_SEED: &[u8] = b"vault";

/// Why a withdrawal paid less than the lender asked for (FR-020).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WithdrawalLimit {
    // The lender asked for more than their shares are worth, and got all they are worth.
    Position,
    // The rest of what the lender asked for is out in loans, and comes back as they are repaid.
    FreeLiquidity,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Withdrawal {
    pub paid: u64,
    pub shares: u64,
    pub limited_by: Option<WithdrawalLimit>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    // May replace `attestor` (FR-012c) and nothing else. It cannot touch the vault.
    pub authority: Pubkey,
    // The ed25519 key whose signature turns an off-chain credit limit into something
    // this program will act on (FR-012a). Kept on chain so that the key in force is
    // visible to anyone, which is the whole mitigation for it being a single point.
    pub attestor: Pubkey,
    pub stable_mint: Pubkey,
    // Token account holding the stablecoin. Owned by this PDA, not by the authority.
    pub vault: Pubkey,
    // Lender shares outstanding (FR-018). Deposits and withdrawals move it.
    pub total_shares: u64,
    // Stablecoin attributable to the pool: deposits, plus interest actually repaid,
    // minus withdrawals. It is cash, whether it currently sits in the vault or in a loan.
    pub total_deposits: u64,
    // Principal currently out in open loans.
    pub total_borrowed: u64,
    // Interest accrued on open loans and not yet repaid. A receivable, not cash. A loan
    // books its interest only when it is touched, so this lags behind what was earned.
    pub accrued_interest: u64,
    // What closes that lag without touching every loan, summed over open loans:
    // outstanding · apr_bps, the same times last_accrual_at, and interest_remainder.
    // Interest earned and not yet booked is (rate · now − rate_time + remainders) over
    // the accrual denominator. A deposit needs it to price a share at this second.
    pub accrual_rate: u128,
    pub accrual_rate_time: u128,
    pub accrual_remainders: u128,
    // Principal of loans written down as overdue (FR-021).
    pub overdue_principal: u64,
    // Rate curve a new loan is priced on (FR-009): the base rate plus the premium times
    // utilisation. Fixed at pool creation; `base + premium` is checked to fit u16 there.
    pub base_apr_bps: u16,
    pub slope_apr_bps: u16,
    pub bump: u8,
}

impl Pool {
    /// What the pool can still lend out right now.
    ///
    /// Accrued interest is deliberately not part of this: it has not been paid in, and
    /// lending against it would lend money the vault does not hold (SC-007).
    pub fn free_liquidity(&self) -> Result<u64> {
        self.total_deposits
            .checked_sub(self.total_borrowed)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))
    }

    /// Adds an open loan to the accrual sums. Called after anything that changes the loan's
    /// outstanding principal, its last accrual or its remainder; a repaid loan earns
    /// nothing more, so it is left out.
    pub fn track(&mut self, loan: &Loan) -> Result<()> {
        if !loan.is_open() {
            return Ok(());
        }
        let terms = loan.accrual_terms()?;
        self.accrual_rate = self
            .accrual_rate
            .checked_add(terms.rate)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        self.accrual_rate_time = self
            .accrual_rate_time
            .checked_add(terms.rate_time)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        self.accrual_remainders = self
            .accrual_remainders
            .checked_add(terms.remainder)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        Ok(())
    }

    /// Takes an open loan out of the accrual sums, before anything changes it.
    pub fn untrack(&mut self, loan: &Loan) -> Result<()> {
        if !loan.is_open() {
            return Ok(());
        }
        let terms = loan.accrual_terms()?;
        self.accrual_rate = self
            .accrual_rate
            .checked_sub(terms.rate)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        self.accrual_rate_time = self
            .accrual_rate_time
            .checked_sub(terms.rate_time)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        self.accrual_remainders = self
            .accrual_remainders
            .checked_sub(terms.remainder)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        Ok(())
    }

    /// Interest the open loans have earned up to `now` and not booked yet.
    pub fn unbooked_interest(&self, now: i64) -> Result<u64> {
        let earned = u128::try_from(now)
            .ok()
            .and_then(|now| self.accrual_rate.checked_mul(now))
            .and_then(|earned| earned.checked_add(self.accrual_remainders))
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        // Negative only if the clock is behind some loan's last accrual. `Loan::accrue`
        // counts that as nothing earned, and so does this, if only for the whole sum.
        let numerator = earned.saturating_sub(self.accrual_rate_time);
        u64::try_from(numerator / ACCRUAL_DENOMINATOR)
            .map_err(|_| error!(RewardFloatError::MathOverflow))
    }

    // Everything the pool holds and is owed at `now`, interest earned up to this second
    // included. Three u64 sums, so it cannot overflow u128.
    fn value(&self, now: i64) -> Result<u128> {
        Ok(u128::from(self.total_deposits)
            + u128::from(self.accrued_interest)
            + u128::from(self.unbooked_interest(now)?))
    }

    /// Shares a deposit of `amount` buys at `now` (FR-018).
    ///
    /// A share is priced on everything the pool is owed as well as what it holds, interest
    /// earned up to this second included, so a newcomer does not buy into interest that
    /// was earned before they came in. Rounded down: the lenders already in are the side
    /// that must not lose to the rounding.
    pub fn shares_for_deposit(&self, amount: u64, now: i64) -> Result<u64> {
        require!(amount > 0, RewardFloatError::InvalidAmount);
        // No shares means no deposits were ever made, and so nothing was lent or earned.
        if self.total_shares == 0 {
            return Ok(amount);
        }
        let value = self.value(now)?;
        // A pool with shares and no value has lost everything, which is only reachable
        // through write-downs (FR-021). Selling shares in it at any price would be wrong.
        let shares = (u128::from(amount) * u128::from(self.total_shares))
            .checked_div(value)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?;
        let shares = u64::try_from(shares).map_err(|_| error!(RewardFloatError::MathOverflow))?;
        require!(shares > 0, RewardFloatError::DepositTooSmall);
        Ok(shares)
    }

    /// What `shares` of the pool are worth at `now` (FR-018a).
    ///
    /// Interest reaches lenders through the price of a share, not through their accounts:
    /// it is the pool's value, interest earned up to this second included, split by shares.
    /// It is the same value a deposit is priced on, so a share is bought and redeemed at
    /// one price. Rounded down: the lenders who stay must not lose to the rounding.
    pub fn value_of_shares(&self, shares: u64, now: i64) -> Result<u64> {
        // A share account never holds more than the pool issued. If one ever claims to, it
        // is a broken book, not a lender to pay.
        require!(shares <= self.total_shares, RewardFloatError::MathOverflow);
        if shares == 0 {
            return Ok(0);
        }
        // shares · value can pass u128 in a large pool; split value by total_shares first.
        // With shares ≤ total, neither product below can, and the floor is the same.
        let total = u128::from(self.total_shares);
        let value = self.value(now)?;
        let shares = u128::from(shares);
        let worth = shares * (value / total) + shares * (value % total) / total;
        u64::try_from(worth).map_err(|_| error!(RewardFloatError::MathOverflow))
    }

    /// What a lender holding `shares` gets for asking to withdraw up to `max_amount` at
    /// `now`, and how many of the shares that costs them (FR-020).
    ///
    /// Asking for more than is free pays what is free rather than nothing: the lender gets
    /// what the pool can give now and is told why it is less. The shares are burned at the
    /// price a deposit pays, rounded up, so the lenders who stay do not lose to rounding.
    pub fn withdrawal(&self, shares: u64, max_amount: u64, now: i64) -> Result<Withdrawal> {
        require!(max_amount > 0, RewardFloatError::InvalidAmount);
        let worth = self.value_of_shares(shares, now)?;
        require!(worth > 0, RewardFloatError::NothingToWithdraw);
        let free = self.free_liquidity()?;
        require!(free > 0, RewardFloatError::NoFreeLiquidity);

        let paid = max_amount.min(worth).min(free);
        let limited_by = if paid == max_amount {
            None
        } else if paid == worth {
            Some(WithdrawalLimit::Position)
        } else {
            Some(WithdrawalLimit::FreeLiquidity)
        };
        // Paying out all the shares are worth burns all of them: a remainder worth less
        // than a unit could never be withdrawn, and is left to the lenders who stay.
        if paid == worth {
            return Ok(Withdrawal {
                paid,
                shares,
                limited_by,
            });
        }
        // paid < worth ≤ shares · value / total, so this is under `shares` and fits u64.
        let burned = (u128::from(paid) * u128::from(self.total_shares)).div_ceil(self.value(now)?);
        Ok(Withdrawal {
            paid,
            shares: u64::try_from(burned).map_err(|_| error!(RewardFloatError::MathOverflow))?,
            limited_by,
        })
    }

    /// Annual rate a new loan of `amount` is issued at.
    ///
    /// Utilisation is taken after the loan, not before it, so one large borrow cannot
    /// take most of the pool at the rate of an idle one. Rounded up: the pool is the side
    /// that waits for its money.
    pub fn quote_apr_bps(&self, amount: u64) -> Result<u16> {
        let borrowed = u128::from(self.total_borrowed) + u128::from(amount);
        let deposits = u128::from(self.total_deposits);
        require!(
            deposits > 0 && borrowed <= deposits,
            RewardFloatError::InsufficientLiquidity
        );
        let premium = (u128::from(self.slope_apr_bps) * borrowed).div_ceil(deposits);
        u16::try_from(u128::from(self.base_apr_bps) + premium)
            .map_err(|_| error!(RewardFloatError::MathOverflow))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RewardFloatError;
    use crate::state::{LoanStatus, REPAYMENT_PERIOD, SECONDS_PER_YEAR};

    fn code(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    fn pool() -> Pool {
        Pool {
            authority: Pubkey::new_unique(),
            attestor: Pubkey::new_unique(),
            stable_mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            total_shares: 0,
            total_deposits: 0,
            total_borrowed: 0,
            accrued_interest: 0,
            accrual_rate: 0,
            accrual_rate_time: 0,
            accrual_remainders: 0,
            overdue_principal: 0,
            base_apr_bps: 800,
            slope_apr_bps: 2_000,
            bump: 253,
        }
    }

    #[test]
    fn free_liquidity_is_what_is_deposited_minus_what_is_lent_out() {
        let mut pool = pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrowed = 400_000;
        assert_eq!(pool.free_liquidity().unwrap(), 600_000);
    }

    #[test]
    fn interest_that_is_only_accrued_is_not_liquidity() {
        // Accrued interest is a receivable: nobody has paid it into the vault yet,
        // so lending against it would lend money the pool does not hold.
        let mut pool = pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrowed = 1_000_000;
        pool.accrued_interest = 250_000;
        assert_eq!(pool.free_liquidity().unwrap(), 0);
    }

    #[test]
    fn a_pool_that_lent_more_than_it_holds_fails_loud() {
        // This state is unreachable if every instruction is right. If it ever shows
        // up, a saturating zero would hide it and keep handing out money.
        let mut pool = pool();
        pool.total_deposits = 10;
        pool.total_borrowed = 11;
        let err = pool.free_liquidity().unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    #[test]
    fn the_rate_is_priced_on_utilisation_after_the_loan() {
        let mut pool = pool();
        pool.total_deposits = 1_000_000_000;
        pool.total_borrowed = 100_000_000;
        // 10 % out already, 30 % once this loan is out: 800 + 2000 × 0.3.
        assert_eq!(pool.quote_apr_bps(200_000_000).unwrap(), 1_400);
    }

    #[test]
    fn the_utilisation_premium_is_rounded_up() {
        let mut pool = pool();
        pool.total_deposits = 3;
        // 2000 × 1/3 = 666.67 of premium.
        assert_eq!(pool.quote_apr_bps(1).unwrap(), 800 + 667);
    }

    #[test]
    fn lending_out_the_whole_pool_costs_base_plus_the_full_premium() {
        let mut pool = pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrowed = 400_000;
        assert_eq!(pool.quote_apr_bps(600_000).unwrap(), 2_800);
    }

    #[test]
    fn the_steepest_curve_the_pool_accepts_still_fits() {
        let mut pool = pool();
        pool.base_apr_bps = 1;
        pool.slope_apr_bps = u16::MAX - 1;
        pool.total_deposits = u64::MAX;
        assert_eq!(pool.quote_apr_bps(u64::MAX).unwrap(), u16::MAX);
    }

    #[test]
    fn no_rate_is_quoted_for_more_than_the_pool_can_lend() {
        let mut pool = pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrowed = 400_000;
        let err = pool.quote_apr_bps(600_001).unwrap_err();
        assert_eq!(
            code(err),
            code(error!(RewardFloatError::InsufficientLiquidity))
        );
        let empty = self::pool();
        let err = empty.quote_apr_bps(1).unwrap_err();
        assert_eq!(
            code(err),
            code(error!(RewardFloatError::InsufficientLiquidity))
        );
    }

    const NOW: i64 = 1_790_157_600;

    fn loan(outstanding: u64, apr_bps: u16, last_accrual_at: i64) -> Loan {
        Loan {
            operator: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            reward_mint: Pubkey::new_unique(),
            nonce: 1,
            principal: outstanding,
            outstanding,
            accrued_interest: 0,
            interest_remainder: 0,
            opened_at: last_accrual_at,
            due_at: last_accrual_at + REPAYMENT_PERIOD,
            last_accrual_at,
            apr_bps,
            sweep_bps: 5_000,
            status: LoanStatus::Active,
            reward_due: 0,
            manual_repayment: None,
            bump: 255,
        }
    }

    #[test]
    fn interest_earned_since_a_loan_was_last_touched_is_unbooked_interest() {
        let mut pool = pool();
        pool.track(&loan(100_000_000, 1_000, NOW)).unwrap();
        assert_eq!(pool.unbooked_interest(NOW).unwrap(), 0);
        // 10 % a year on 100 USDC.
        assert_eq!(
            pool.unbooked_interest(NOW + SECONDS_PER_YEAR).unwrap(),
            10_000_000
        );
    }

    #[test]
    fn unbooked_interest_is_what_the_loans_would_book_if_touched_now() {
        let mut pool = pool();
        let mut loans = [
            loan(123_456_789, 1_317, NOW - 86_400),
            loan(7_654_321, 2_799, NOW - 3_333),
            loan(1, 801, NOW - 17),
        ];
        loans[0].interest_remainder = ACCRUAL_DENOMINATOR as u64 - 1;
        loans[1].interest_remainder = 12_345;
        for loan in &loans {
            pool.track(loan).unwrap();
        }
        let later = NOW + 40 * 86_400 + 7;
        let unbooked = pool.unbooked_interest(later).unwrap();
        let booked: u64 = loans
            .iter_mut()
            .map(|loan| loan.accrue(later).unwrap())
            .sum();
        // The pool rounds the sum once, each loan rounds its own part.
        assert!(unbooked >= booked && unbooked - booked < loans.len() as u64);
        assert!(booked > 0);
    }

    #[test]
    fn a_loan_untracked_after_being_tracked_leaves_nothing_behind() {
        let mut pool = pool();
        let mut first = loan(50_000_000, 1_200, NOW - 600);
        first.interest_remainder = 999;
        let second = loan(20_000_000, 900, NOW);
        pool.track(&first).unwrap();
        pool.track(&second).unwrap();
        pool.untrack(&first).unwrap();
        let mut alone = self::pool();
        alone.track(&second).unwrap();
        assert_eq!(
            (
                pool.accrual_rate,
                pool.accrual_rate_time,
                pool.accrual_remainders
            ),
            (
                alone.accrual_rate,
                alone.accrual_rate_time,
                alone.accrual_remainders
            )
        );
        assert_ne!(pool.accrual_rate, 0);
        pool.untrack(&second).unwrap();
        assert_eq!(
            (
                pool.accrual_rate,
                pool.accrual_rate_time,
                pool.accrual_remainders
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn a_repaid_loan_is_neither_tracked_nor_untracked() {
        let mut pool = pool();
        let mut repaid = loan(0, 1_000, NOW);
        repaid.interest_remainder = 77;
        repaid.status = LoanStatus::Repaid;
        pool.track(&repaid).unwrap();
        assert_eq!(pool.accrual_remainders, 0);
        pool.untrack(&repaid).unwrap();
        assert_eq!(pool.accrual_remainders, 0);
    }

    #[test]
    fn untracking_a_loan_that_was_never_tracked_fails_loud() {
        let mut pool = pool();
        let err = pool.untrack(&loan(1, 1_000, NOW)).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    #[test]
    fn the_first_deposit_buys_one_share_per_unit() {
        let pool = pool();
        assert_eq!(
            pool.shares_for_deposit(250_000_000, NOW).unwrap(),
            250_000_000
        );
    }

    #[test]
    fn a_share_is_priced_on_deposits_plus_booked_interest() {
        let mut pool = pool();
        pool.total_shares = 1_000_000;
        pool.total_deposits = 1_000_000;
        pool.accrued_interest = 250_000;
        // Each share is worth 1.25 units.
        assert_eq!(pool.shares_for_deposit(125_000, NOW).unwrap(), 100_000);
    }

    #[test]
    fn a_share_is_priced_on_interest_earned_up_to_this_second() {
        let mut pool = pool();
        pool.total_shares = 100_000_000;
        pool.total_deposits = 100_000_000;
        pool.total_borrowed = 100_000_000;
        pool.track(&loan(100_000_000, 1_000, NOW)).unwrap();
        // A year in, the pool is worth 110 USDC: 11 units buy 10 shares.
        assert_eq!(
            pool.shares_for_deposit(11_000_000, NOW + SECONDS_PER_YEAR)
                .unwrap(),
            10_000_000
        );
    }

    #[test]
    fn the_share_count_is_rounded_down() {
        let mut pool = pool();
        pool.total_shares = 3;
        pool.total_deposits = 4;
        // 5 · 3 / 4 = 3.75 shares.
        assert_eq!(pool.shares_for_deposit(5, NOW).unwrap(), 3);
    }

    #[test]
    fn a_deposit_worth_less_than_one_share_is_refused() {
        let mut pool = pool();
        pool.total_shares = 2;
        pool.total_deposits = 5;
        let err = pool.shares_for_deposit(2, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::DepositTooSmall)));
        assert_eq!(pool.shares_for_deposit(3, NOW).unwrap(), 1);
    }

    #[test]
    fn a_deposit_of_nothing_is_refused() {
        let err = pool().shares_for_deposit(0, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::InvalidAmount)));
    }

    #[test]
    fn the_largest_deposit_into_the_largest_pool_does_not_wrap() {
        let mut pool = pool();
        pool.total_shares = u64::MAX;
        pool.total_deposits = u64::MAX;
        pool.accrued_interest = u64::MAX;
        assert_eq!(
            pool.shares_for_deposit(u64::MAX, NOW).unwrap(),
            u64::MAX / 2
        );
    }

    #[test]
    fn lenders_split_the_interest_by_their_shares_without_doing_anything() {
        let mut pool = pool();
        pool.total_shares = 100_000_000;
        pool.total_deposits = 100_000_000;
        pool.total_borrowed = 100_000_000;
        pool.track(&loan(100_000_000, 1_000, NOW)).unwrap();
        let (first, second) = (75_000_000, 25_000_000);
        assert_eq!(pool.value_of_shares(first, NOW).unwrap(), 75_000_000);
        // A year of 10 % on the whole pool, and nobody touched a share or a loan.
        let later = NOW + SECONDS_PER_YEAR;
        assert_eq!(pool.value_of_shares(first, later).unwrap(), 82_500_000);
        assert_eq!(pool.value_of_shares(second, later).unwrap(), 27_500_000);
    }

    #[test]
    fn booked_interest_is_shared_like_unbooked_interest() {
        let mut pool = pool();
        pool.total_shares = 4;
        pool.total_deposits = 1_000;
        pool.accrued_interest = 200;
        assert_eq!(pool.value_of_shares(1, NOW).unwrap(), 300);
    }

    #[test]
    fn shares_just_bought_are_worth_no_more_than_was_paid() {
        let mut pool = pool();
        pool.total_shares = 100_000_000;
        pool.total_deposits = 100_000_000;
        pool.total_borrowed = 100_000_000;
        pool.track(&loan(100_000_000, 1_317, NOW - 86_400)).unwrap();
        let amount = 33_333_333;
        let shares = pool.shares_for_deposit(amount, NOW).unwrap();
        pool.total_shares += shares;
        pool.total_deposits += amount;
        let worth = pool.value_of_shares(shares, NOW).unwrap();
        // A round trip at one price: no gain, and a loss of no more than the rounding,
        // which is under one share on the way in and one unit on the way out.
        let one_share = pool.value_of_shares(1, NOW).unwrap();
        assert!(worth <= amount && amount - worth <= one_share + 1);
    }

    #[test]
    fn the_value_of_shares_is_rounded_down() {
        let mut pool = pool();
        pool.total_shares = 3;
        pool.total_deposits = 4;
        // 4 / 3 = 1.33 units a share.
        assert_eq!(pool.value_of_shares(1, NOW).unwrap(), 1);
        assert_eq!(pool.value_of_shares(3, NOW).unwrap(), 4);
    }

    #[test]
    fn no_shares_are_worth_nothing() {
        assert_eq!(pool().value_of_shares(0, NOW).unwrap(), 0);
        let mut pool = pool();
        pool.total_shares = 10;
        pool.total_deposits = 10;
        assert_eq!(pool.value_of_shares(0, NOW).unwrap(), 0);
    }

    #[test]
    fn more_shares_than_the_pool_issued_fails_loud() {
        let mut pool = pool();
        pool.total_shares = 10;
        pool.total_deposits = 10;
        let err = pool.value_of_shares(11, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
        let err = self::pool().value_of_shares(1, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    #[test]
    fn the_value_of_shares_in_the_largest_pool_does_not_wrap() {
        let mut pool = pool();
        pool.total_shares = u64::MAX;
        pool.total_deposits = u64::MAX;
        pool.accrued_interest = u64::MAX;
        assert_eq!(
            pool.value_of_shares(u64::MAX / 2, NOW).unwrap(),
            u64::MAX - 1
        );
        let err = pool.value_of_shares(u64::MAX, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    // 1000 shares for 1250 units: 1.25 a share. The lender holds 400 of them, worth 500.
    fn priced_pool() -> Pool {
        let mut pool = pool();
        pool.total_shares = 1_000;
        pool.total_deposits = 1_000;
        pool.accrued_interest = 250;
        pool
    }

    #[test]
    fn a_withdrawal_pays_what_was_asked_and_burns_the_shares_it_is_worth() {
        assert_eq!(
            priced_pool().withdrawal(400, 125, NOW).unwrap(),
            Withdrawal {
                paid: 125,
                shares: 100,
                limited_by: None,
            }
        );
    }

    #[test]
    fn the_shares_burned_are_rounded_up() {
        // 1 unit is 0.8 of a share: the lender gives up a whole one, so that the lenders
        // who stay do not lose to the rounding.
        assert_eq!(priced_pool().withdrawal(400, 1, NOW).unwrap().shares, 1);
    }

    #[test]
    fn asking_for_more_than_the_shares_are_worth_pays_them_all_out() {
        assert_eq!(
            priced_pool().withdrawal(400, u64::MAX, NOW).unwrap(),
            Withdrawal {
                paid: 500,
                shares: 400,
                limited_by: Some(WithdrawalLimit::Position),
            }
        );
    }

    #[test]
    fn leaving_the_pool_burns_every_share_even_past_the_rounding() {
        let mut pool = pool();
        pool.total_shares = 10;
        pool.total_deposits = 3;
        // Six shares at 0.3 are worth 1.8 and pay 1, which is priced at 3.33 shares.
        // Burning only 4 would leave two shares worth 0.6 that could never be withdrawn.
        assert_eq!(
            pool.withdrawal(6, u64::MAX, NOW).unwrap(),
            Withdrawal {
                paid: 1,
                shares: 6,
                limited_by: Some(WithdrawalLimit::Position),
            }
        );
    }

    #[test]
    fn a_withdrawal_past_the_free_liquidity_pays_what_is_free_and_says_so() {
        let mut pool = priced_pool();
        pool.total_borrowed = 700;
        assert_eq!(
            pool.withdrawal(400, 500, NOW).unwrap(),
            Withdrawal {
                paid: 300,
                shares: 240,
                limited_by: Some(WithdrawalLimit::FreeLiquidity),
            }
        );
    }

    #[test]
    fn a_withdrawal_is_priced_on_interest_earned_up_to_this_second() {
        let mut pool = pool();
        pool.total_shares = 100_000_000;
        pool.total_deposits = 100_000_000;
        pool.total_borrowed = 50_000_000;
        pool.track(&loan(50_000_000, 1_000, NOW)).unwrap();
        // A year of 10 % on half the pool: 105 USDC for 100 million shares.
        let withdrawal = pool
            .withdrawal(40_000_000, u64::MAX, NOW + SECONDS_PER_YEAR)
            .unwrap();
        assert_eq!(
            withdrawal,
            Withdrawal {
                paid: 42_000_000,
                shares: 40_000_000,
                limited_by: Some(WithdrawalLimit::Position),
            }
        );
    }

    #[test]
    fn the_lenders_who_stay_lose_nothing_per_share() {
        let mut pool = pool();
        pool.total_shares = 100_000_000;
        pool.total_deposits = 100_000_000;
        pool.total_borrowed = 60_000_000;
        pool.track(&loan(60_000_000, 1_317, NOW - 86_400)).unwrap();
        let before = (pool.value(NOW).unwrap(), u128::from(pool.total_shares));
        let withdrawal = pool.withdrawal(70_000_000, 33_333_333, NOW).unwrap();
        pool.total_shares -= withdrawal.shares;
        pool.total_deposits -= withdrawal.paid;
        let after = (pool.value(NOW).unwrap(), u128::from(pool.total_shares));
        assert!(after.0 * before.1 >= before.0 * after.1);
        assert_eq!(withdrawal.paid, 33_333_333);
    }

    #[test]
    fn a_pool_with_nothing_free_explains_instead_of_paying_nothing() {
        let mut pool = priced_pool();
        pool.total_borrowed = 1_000;
        let err = pool.withdrawal(400, 1, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::NoFreeLiquidity)));
    }

    #[test]
    fn a_lender_with_nothing_to_withdraw_is_refused() {
        let err = priced_pool().withdrawal(0, 1, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::NothingToWithdraw)));
        // Shares in a pool written down to nothing are worth nothing either.
        let mut wiped = pool();
        wiped.total_shares = 10;
        let err = wiped.withdrawal(10, 1, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::NothingToWithdraw)));
    }

    #[test]
    fn a_withdrawal_of_nothing_is_refused() {
        let err = priced_pool().withdrawal(400, 0, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::InvalidAmount)));
    }

    #[test]
    fn withdrawing_more_shares_than_the_pool_issued_fails_loud() {
        let err = priced_pool().withdrawal(1_001, 1, NOW).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }

    #[test]
    fn a_withdrawal_from_the_largest_pool_does_not_wrap() {
        let mut pool = pool();
        pool.total_shares = u64::MAX;
        pool.total_deposits = u64::MAX;
        pool.accrued_interest = u64::MAX;
        // Two units a share: a third of u64::MAX costs a sixth of the shares, rounded up.
        let withdrawal = pool.withdrawal(u64::MAX / 2, u64::MAX / 3, NOW).unwrap();
        assert_eq!(withdrawal.paid, u64::MAX / 3);
        assert_eq!(withdrawal.shares, (u64::MAX / 3).div_ceil(2));
    }

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // authority 32 + attestor 32 + stable_mint 32 + vault 32
        // + total_shares 8 + total_deposits 8 + total_borrowed 8
        // + accrued_interest 8 + accrual_rate 16 + accrual_rate_time 16
        // + accrual_remainders 16 + overdue_principal 8 + base_apr_bps 2
        // + slope_apr_bps 2 + bump 1
        assert_eq!(Pool::INIT_SPACE, 221);
    }
}
