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
}
