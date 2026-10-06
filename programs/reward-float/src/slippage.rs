// The tolerance check of FR-015a. It lives apart from ConversionVault because on mainnet the
// vault gives way to an aggregator, and this check is what stays.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

const BPS: u128 = 10_000;
const RATE_DENOMINATOR: u128 = 1_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConversionCheck {
    // Rounded up, so the reported deviation never understates what the operator lost.
    pub deviation_bps: u16,
    pub within_tolerance: bool,
}

/// How far `received` stablecoin falls below the attested value of `amount` reward units,
/// with the rate in stablecoin per 10¹² reward units, and whether that fits `max_slippage_bps`.
pub fn check_conversion(
    amount: u64,
    stable_per_trillion_reward: u64,
    received: u64,
    max_slippage_bps: u16,
) -> Result<ConversionCheck> {
    // Both sides in 10⁻¹² of a stablecoin unit: the attested value is compared unrounded, and
    // a u64 by u64 product always fits a u128.
    let value = u128::from(amount) * u128::from(stable_per_trillion_reward);
    let paid = u128::from(received) * RATE_DENOMINATOR;
    let deviation = if paid >= value {
        0
    } else {
        (value - paid)
            .checked_mul(BPS)
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?
            .div_ceil(value)
    };
    let deviation_bps =
        u16::try_from(deviation).map_err(|_| error!(RewardFloatError::MathOverflow))?;
    // With a whole-number tolerance, comparing the rounded-up deviation decides exactly as
    // comparing the unrounded one would.
    Ok(ConversionCheck {
        deviation_bps,
        within_tolerance: deviation_bps <= max_slippage_bps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ConversionVault;

    // Expected values worked out in Python, apart from this implementation:
    // ceil((amount · rate / 10¹² − received) / (amount · rate / 10¹²) · 10 000), unrounded value.
    const HONEY_AT_0_0023: u64 = 2_300_000;
    const HNT_AT_3_10: u64 = 31_000_000_000;
    const HONEY: u64 = 1_234_567_890_123;
    const HNT: u64 = 5_000_000_000;

    fn code(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    fn vault(spread_bps: u16) -> ConversionVault {
        ConversionVault {
            pool: Pubkey::new_unique(),
            reward_mint: Pubkey::new_unique(),
            stable_vault: Pubkey::new_unique(),
            reward_vault: Pubkey::new_unique(),
            spread_bps,
            max_slippage_bps: 100,
            bump: 255,
        }
    }

    #[test]
    fn a_quote_inside_the_tolerance_passes_with_its_deviation() {
        // 154.535 for $155 worth of HNT is 30 bps short, exactly.
        let received = vault(30).quote(HNT, HNT_AT_3_10).unwrap();
        assert_eq!(
            check_conversion(HNT, HNT_AT_3_10, received, 100).unwrap(),
            ConversionCheck {
                deviation_bps: 30,
                within_tolerance: true
            }
        );
    }

    #[test]
    fn the_deviation_counts_the_quote_rounding_against_the_market() {
        // 2.830987 for 2.8395061…: the 30 bps spread plus the unit the quote rounded away.
        let received = vault(30).quote(HONEY, HONEY_AT_0_0023).unwrap();
        assert_eq!(
            check_conversion(HONEY, HONEY_AT_0_0023, received, 100)
                .unwrap()
                .deviation_bps,
            31
        );
        let received = vault(0).quote(HONEY, HONEY_AT_0_0023).unwrap();
        assert_eq!(
            check_conversion(HONEY, HONEY_AT_0_0023, received, 100)
                .unwrap()
                .deviation_bps,
            1
        );
    }

    #[test]
    fn a_deviation_equal_to_the_tolerance_still_fits() {
        let received = vault(100).quote(HNT, HNT_AT_3_10).unwrap();
        assert!(
            check_conversion(HNT, HNT_AT_3_10, received, 100)
                .unwrap()
                .within_tolerance
        );
        assert!(
            !check_conversion(HNT, HNT_AT_3_10, received, 99)
                .unwrap()
                .within_tolerance
        );
    }

    #[test]
    fn a_vault_spread_equal_to_the_tolerance_falls_outside_once_the_quote_rounds() {
        let received = vault(100).quote(HONEY, HONEY_AT_0_0023).unwrap();
        assert_eq!(
            check_conversion(HONEY, HONEY_AT_0_0023, received, 100).unwrap(),
            ConversionCheck {
                deviation_bps: 101,
                within_tolerance: false
            }
        );
    }

    #[test]
    fn a_fraction_of_a_basis_point_rounds_up() {
        // 2 for a value of 3 is 3333.3… bps short.
        let check = check_conversion(3, 1_000_000_000_000, 2, 3_334).unwrap();
        assert_eq!(check.deviation_bps, 3_334);
        assert!(check.within_tolerance);
        assert!(
            !check_conversion(3, 1_000_000_000_000, 2, 3_333)
                .unwrap()
                .within_tolerance
        );
    }

    #[test]
    fn receiving_at_least_the_attested_value_is_no_deviation() {
        for received in [155_000_000, 155_000_001] {
            assert_eq!(
                check_conversion(HNT, HNT_AT_3_10, received, 0).unwrap(),
                ConversionCheck {
                    deviation_bps: 0,
                    within_tolerance: true
                }
            );
        }
    }

    #[test]
    fn receiving_nothing_fits_no_tolerance() {
        assert_eq!(
            check_conversion(HNT, HNT_AT_3_10, 0, 9_999).unwrap(),
            ConversionCheck {
                deviation_bps: 10_000,
                within_tolerance: false
            }
        );
        // Less than one stablecoin unit's worth that the market rounds to nothing is a full loss
        // too, not a pass.
        assert_eq!(
            check_conversion(333, 3_000_000_000, 0, 9_999)
                .unwrap()
                .deviation_bps,
            10_000
        );
    }

    #[test]
    fn converting_nothing_loses_nothing() {
        assert_eq!(
            check_conversion(0, HONEY_AT_0_0023, 0, 0).unwrap(),
            ConversionCheck {
                deviation_bps: 0,
                within_tolerance: true
            }
        );
    }

    #[test]
    fn a_value_beyond_what_the_arithmetic_holds_is_refused() {
        let err = check_conversion(u64::MAX, u64::MAX, 0, 100).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }
}
