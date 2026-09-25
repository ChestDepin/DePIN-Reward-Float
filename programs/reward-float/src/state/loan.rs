// One loan. Everything about it is fixed at issue time (FR-009): the rate does not
// move with pool utilisation, and the schedule does not move at all.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

/// Seed prefix of the loan PDA: `["loan", operator, nonce]`.
pub const LOAN_SEED: &[u8] = b"loan";

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
    // Interest accrued and not yet repaid. T039 is what moves it.
    pub accrued_interest: u64,
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

    /// Whether this loan still counts towards the operator's debt.
    pub fn is_open(&self) -> bool {
        !matches!(self.status, LoanStatus::Repaid)
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

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // operator 32 + pool 32 + reward_mint 32 + nonce 8 + principal 8
        // + outstanding 8 + accrued_interest 8 + opened_at 8 + due_at 8
        // + last_accrual_at 8 + apr_bps 2 + sweep_bps 2 + status 1 + bump 1
        assert_eq!(Loan::INIT_SPACE, 158);
    }
}
