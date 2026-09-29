// The shared pot of stablecoin: what lenders put in, what operators took out, and
// the key that is allowed to vouch for an operator's credit limit.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

/// Seed prefix of the pool PDA: `["pool", stable_mint]`.
pub const POOL_SEED: &[u8] = b"pool";

/// Seed prefix of the vault token account PDA: `["vault", pool]`.
pub const VAULT_SEED: &[u8] = b"vault";

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
    // Interest accrued on open loans and not yet repaid. A receivable, not cash.
    pub accrued_interest: u64,
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

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // authority 32 + attestor 32 + stable_mint 32 + vault 32
        // + total_shares 8 + total_deposits 8 + total_borrowed 8
        // + accrued_interest 8 + overdue_principal 8 + base_apr_bps 2
        // + slope_apr_bps 2 + bump 1
        assert_eq!(Pool::INIT_SPACE, 173);
    }
}
