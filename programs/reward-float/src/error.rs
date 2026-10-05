// Error codes of the program. These strings end up in the public IDL, so they are
// written for whoever reads a failed transaction, not for us.
use anchor_lang::prelude::*;

#[error_code]
pub enum RewardFloatError {
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("attestation nonce is older than the replay window and can no longer be checked")]
    AttestationNonceTooOld,
    #[msg("attestation nonce was already used")]
    AttestationNonceAlreadyUsed,
    #[msg("only the upgrade authority of this program can create a pool")]
    NotUpgradeAuthority,
    #[msg("only the pool authority can replace the attestor")]
    NotPoolAuthority,
    #[msg("the attestor key cannot be the all-zero key")]
    InvalidAttestor,
    #[msg(
        "the instruction right before this one must be the ed25519 check of a limit attestation"
    )]
    AttestationMissing,
    #[msg("the limit attestation or its ed25519 check is not laid out as expected")]
    AttestationMalformed,
    #[msg("the limit attestation is not signed by the pool attestor")]
    AttestationWrongSigner,
    #[msg("the limit attestation was issued for another operator")]
    AttestationWrongOperator,
    #[msg("the limit attestation has expired")]
    AttestationExpired,
    #[msg("the limit attestation claims to stay valid for longer than the program allows")]
    AttestationValidityTooLong,
    #[msg("the limit attestation was computed from data older than a day")]
    AttestationStale,
    #[msg("the base rate plus the utilisation premium must fit in u16 basis points")]
    InvalidRateCurve,
    #[msg("the amount must be greater than zero")]
    InvalidAmount,
    #[msg("the loan term must be between one and the maximum number of periods")]
    InvalidTerm,
    #[msg("the share of rewards withheld must be between 1 and 10000 basis points")]
    InvalidSweepShare,
    #[msg("an operator with an overdue loan cannot borrow")]
    OperatorOverdue,
    #[msg("the loan would take the operator's debt over the attested credit limit")]
    CreditLimitExceeded,
    #[msg("the pool does not have enough free liquidity for this loan")]
    InsufficientLiquidity,
    #[msg("the rate for this loan is above the maximum the operator agreed to")]
    RateAboveMaximum,
    #[msg("the loan nonce is not the nonce of the limit attestation")]
    AttestationNonceMismatch,
    #[msg("the loan is already repaid")]
    LoanNotOpen,
    #[msg("every open loan of the operator in this pool has to be passed, writable and once")]
    OpenLoansMismatch,
    #[msg("the operator already has the maximum number of open loans")]
    TooManyOpenLoans,
    #[msg("the deposit is worth less than one share of the pool")]
    DepositTooSmall,
}
