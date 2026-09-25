// Everything the program knows about one operator: how deep they are in, and which
// limit attestations they have already spent.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

/// Seed prefix of the operator PDA: `["operator", owner]`.
pub const OPERATOR_SEED: &[u8] = b"operator";

/// How many nonces back the replay window reaches.
///
/// FR-012b only asks that the same attestation cannot be presented twice, and an
/// attestation is valid for five minutes, so the window has to cover just the nonces
/// that can still be in flight. It is a window and not a list because a growing vector
/// would cost rent forever to remember nonces that expired minutes after they were cut.
///
/// 256 is a margin, not a measurement: the issuing endpoint is open, so anyone can burn
/// an operator's nonces, and a wallet that reloads its dashboard a few dozen times still
/// has an attestation from the first load inside the window. Refusing a nonce that fell
/// out is safe anyway — the operator asks for a fresh attestation and retries.
pub const NONCE_WINDOW: u64 = 256;

/// The window as 64-bit words, which is how it is stored.
pub const NONCE_WINDOW_WORDS: usize = (NONCE_WINDOW / 64) as usize;

#[account]
#[derive(InitSpace)]
pub struct OperatorAccount {
    pub owner: Pubkey,
    // Principal plus accrued interest across every open loan. This is the number the
    // credit limit is checked against at issue time (FR-012).
    pub total_debt: u64,
    pub open_loans: u32,
    // Set when a loan of this operator passes the overdue threshold (FR-021). While it
    // is set the limit is zero, whatever an attestation says.
    pub overdue: bool,
    // Lowest nonce the window still remembers. Anything below it is refused as too old.
    pub nonce_floor: u64,
    // One bit per nonce in `[nonce_floor, nonce_floor + NONCE_WINDOW)`, least significant
    // bit of word 0 being `nonce_floor`. A set bit means that nonce was spent.
    pub used_nonces: [u64; NONCE_WINDOW_WORDS],
    pub bump: u8,
}

impl OperatorAccount {
    /// Spends one limit attestation nonce, refusing a replay (FR-012b).
    ///
    /// The window is dragged forward by the nonces that are actually spent, never by the
    /// ones that are merely issued — the program does not see issuance, and tying the
    /// window to it would let anyone push a stranger's live attestation out of range.
    pub fn consume_nonce(&mut self, nonce: u64) -> Result<()> {
        if nonce < self.nonce_floor {
            return Err(error!(RewardFloatError::AttestationNonceTooOld));
        }

        let offset = nonce - self.nonce_floor;
        if offset >= NONCE_WINDOW {
            // Keep the window ending on the highest nonce ever spent.
            let slide = offset - (NONCE_WINDOW - 1);
            shift_window_down(&mut self.used_nonces, slide);
            self.nonce_floor += slide;
        }

        let bit = (nonce - self.nonce_floor) as usize;
        let (word, mask) = (bit / 64, 1u64 << (bit % 64));
        if self.used_nonces[word] & mask != 0 {
            return Err(error!(RewardFloatError::AttestationNonceAlreadyUsed));
        }
        self.used_nonces[word] |= mask;
        Ok(())
    }
}

/// Drops the lowest `by` nonces out of the window and shifts the rest down to match.
fn shift_window_down(words: &mut [u64; NONCE_WINDOW_WORDS], by: u64) {
    if by >= NONCE_WINDOW {
        *words = [0; NONCE_WINDOW_WORDS];
        return;
    }

    let whole_words = (by / 64) as usize;
    let bits = (by % 64) as u32;
    let mut shifted = [0u64; NONCE_WINDOW_WORDS];
    for (target, source) in (whole_words..NONCE_WINDOW_WORDS).enumerate() {
        let mut value = words[source] >> bits;
        // A shift by 64 panics with overflow checks on and masks to a shift by 0 without
        // them, so the carry from the word above is only pulled in when the shift is
        // partial and there is somewhere to pull it into.
        if bits > 0 && source + 1 < NONCE_WINDOW_WORDS {
            value |= words[source + 1] << (64 - bits);
        }
        shifted[target] = value;
    }
    *words = shifted;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RewardFloatError;

    fn fresh() -> OperatorAccount {
        OperatorAccount {
            owner: Pubkey::new_unique(),
            total_debt: 0,
            open_loans: 0,
            overdue: false,
            nonce_floor: 0,
            used_nonces: [0; NONCE_WINDOW_WORDS],
            bump: 254,
        }
    }

    fn code(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    fn too_old() -> u32 {
        code(error!(RewardFloatError::AttestationNonceTooOld))
    }

    fn already_used() -> u32 {
        code(error!(RewardFloatError::AttestationNonceAlreadyUsed))
    }

    #[test]
    fn the_window_is_256_nonces_wide() {
        assert_eq!(NONCE_WINDOW, 256);
        assert_eq!(NONCE_WINDOW_WORDS * 64, NONCE_WINDOW as usize);
    }

    #[test]
    fn a_fresh_account_accepts_the_first_nonce() {
        let mut operator = fresh();
        assert!(operator.consume_nonce(1).is_ok());
        assert_eq!(operator.nonce_floor, 0);
    }

    #[test]
    fn the_same_nonce_is_rejected_the_second_time() {
        let mut operator = fresh();
        operator.consume_nonce(7).unwrap();
        let err = operator.consume_nonce(7).unwrap_err();
        assert_eq!(code(err), already_used());
    }

    #[test]
    fn nonces_may_be_consumed_out_of_order_inside_the_window() {
        // Two attestations issued back to back are both valid for five minutes, and
        // nothing says the operator must spend them in the order they were issued.
        let mut operator = fresh();
        operator.consume_nonce(10).unwrap();
        assert!(operator.consume_nonce(5).is_ok());
        assert_eq!(
            code(operator.consume_nonce(10).unwrap_err()),
            already_used()
        );
        assert_eq!(code(operator.consume_nonce(5).unwrap_err()), already_used());
    }

    #[test]
    fn a_nonce_below_the_floor_is_rejected_as_too_old() {
        let mut operator = fresh();
        operator.nonce_floor = 100;
        let err = operator.consume_nonce(99).unwrap_err();
        assert_eq!(code(err), too_old());
    }

    #[test]
    fn the_last_nonce_of_the_window_does_not_slide_it() {
        let mut operator = fresh();
        operator.consume_nonce(NONCE_WINDOW - 1).unwrap();
        assert_eq!(operator.nonce_floor, 0);
        // The floor stayed put, so nonce 0 is still spendable.
        assert!(operator.consume_nonce(0).is_ok());
    }

    #[test]
    fn one_past_the_window_slides_it_by_exactly_one() {
        let mut operator = fresh();
        operator.consume_nonce(NONCE_WINDOW).unwrap();
        assert_eq!(operator.nonce_floor, 1);
        assert_eq!(code(operator.consume_nonce(0).unwrap_err()), too_old());
        assert!(operator.consume_nonce(1).is_ok());
    }

    #[test]
    fn a_nonce_above_the_window_slides_it_forward() {
        let mut operator = fresh();
        operator.consume_nonce(1).unwrap();
        operator.consume_nonce(1000).unwrap();
        // The window always ends on the highest nonce ever consumed.
        assert_eq!(operator.nonce_floor, 1000 - (NONCE_WINDOW - 1));
        assert_eq!(code(operator.consume_nonce(744).unwrap_err()), too_old());
        assert!(operator.consume_nonce(745).is_ok());
    }

    #[test]
    fn sliding_keeps_the_nonces_that_stay_inside_the_window() {
        let mut operator = fresh();
        operator.consume_nonce(200).unwrap();
        operator.consume_nonce(300).unwrap();
        assert_eq!(operator.nonce_floor, 45);
        // 200 is still inside [45, 301), so the replay is still recognised as one.
        assert_eq!(
            code(operator.consume_nonce(200).unwrap_err()),
            already_used()
        );
    }

    #[test]
    fn sliding_drops_the_nonces_that_fall_out_of_the_window() {
        let mut operator = fresh();
        operator.consume_nonce(1).unwrap();
        operator.consume_nonce(400).unwrap();
        // Nonce 1 is no longer remembered, but it is refused all the same — an
        // attestation that old has been expired for a long time.
        assert_eq!(code(operator.consume_nonce(1).unwrap_err()), too_old());
    }

    #[test]
    fn a_jump_beyond_the_whole_window_clears_it() {
        let mut operator = fresh();
        for nonce in 0..NONCE_WINDOW {
            operator.consume_nonce(nonce).unwrap();
        }
        operator.consume_nonce(u64::MAX).unwrap();
        assert_eq!(operator.nonce_floor, u64::MAX - (NONCE_WINDOW - 1));
        assert!(operator.consume_nonce(u64::MAX - 1).is_ok());
        assert_eq!(
            code(operator.consume_nonce(u64::MAX).unwrap_err()),
            already_used()
        );
    }

    #[test]
    fn bits_survive_a_slide_of_exactly_one_word() {
        let mut operator = fresh();
        let marked = [64_u64, 65, 127, 128, 200, 255];
        for nonce in marked {
            operator.consume_nonce(nonce).unwrap();
        }
        operator.consume_nonce(255 + 64).unwrap();
        assert_eq!(operator.nonce_floor, 64);
        for nonce in marked {
            assert_eq!(
                code(operator.consume_nonce(nonce).unwrap_err()),
                already_used(),
                "nonce {nonce} lost its bit across a whole-word slide"
            );
        }
    }

    #[test]
    fn bits_survive_a_slide_across_a_word_boundary() {
        // A slide of 7 bits moves every bit into a different position inside its word
        // and pushes six of them into the word below. This is the case an off-by-one
        // in the shift would survive.
        let mut operator = fresh();
        let marked = [7_u64, 63, 64, 65, 127, 128, 191, 192, 255];
        for nonce in marked {
            operator.consume_nonce(nonce).unwrap();
        }
        operator.consume_nonce(255 + 7).unwrap();
        assert_eq!(operator.nonce_floor, 7);
        for nonce in marked {
            assert_eq!(
                code(operator.consume_nonce(nonce).unwrap_err()),
                already_used(),
                "nonce {nonce} lost its bit across a 7-bit slide"
            );
        }
    }

    #[test]
    fn the_floor_never_moves_backwards() {
        let mut operator = fresh();
        operator.consume_nonce(5000).unwrap();
        let floor = operator.nonce_floor;
        operator.consume_nonce(4800).unwrap();
        assert_eq!(operator.nonce_floor, floor);
    }

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // owner 32 + total_debt 8 + open_loans 4 + overdue 1
        // + nonce_floor 8 + used_nonces 32 + bump 1
        assert_eq!(OperatorAccount::INIT_SPACE, 86);
    }
}
