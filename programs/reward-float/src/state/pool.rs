// The shared pot of stablecoin: what lenders put in, what operators took out, and
// the key that is allowed to vouch for an operator's credit limit.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

/// Seed prefix of the pool PDA: `["pool", stable_mint]`.
pub const POOL_SEED: &[u8] = b"pool";

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
    fn the_layout_is_the_one_we_declared() {
        // authority 32 + attestor 32 + stable_mint 32 + vault 32
        // + total_shares 8 + total_deposits 8 + total_borrowed 8
        // + accrued_interest 8 + overdue_principal 8 + bump 1
        assert_eq!(Pool::INIT_SPACE, 169);
    }
}
