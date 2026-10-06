// The devnet stand-in for a market (FR-015): a pot of the pool's stablecoin that buys one
// reward token. On mainnet an aggregator takes its place, and with it goes only where the
// quote comes from; the slippage check and the "no fit, no withholding" rule stay as they are.
use anchor_lang::prelude::*;

use crate::error::RewardFloatError;

/// Seed prefix of the conversion vault PDA: `["conv", pool, reward_mint]`.
pub const CONVERSION_SEED: &[u8] = b"conv";

/// Seed prefix of its stablecoin token account PDA: `["conv_stable", conversion_vault]`.
pub const CONVERSION_STABLE_SEED: &[u8] = b"conv_stable";

/// Seed prefix of its reward token account PDA: `["conv_reward", conversion_vault]`.
pub const CONVERSION_REWARD_SEED: &[u8] = b"conv_reward";

const BPS: u128 = 10_000;
const RATE_DENOMINATOR: u128 = 1_000_000_000_000;

#[account]
#[derive(InitSpace)]
pub struct ConversionVault {
    // Tied to one pool so that what it pays out is that pool's stablecoin.
    pub pool: Pubkey,
    pub reward_mint: Pubkey,
    pub stable_vault: Pubkey,
    // Where withheld rewards end up, so that the pool itself never holds them (FR-015).
    pub reward_vault: Pubkey,
    // How far below the attested rate this market quotes. Without it the quote would equal
    // the attested rate, and a conversion outside the tolerance could never happen on devnet.
    pub spread_bps: u16,
    // The tolerance of FR-015a: how far a quote may fall below the attested rate.
    pub max_slippage_bps: u16,
    pub bump: u8,
}

impl ConversionVault {
    /// Stablecoin this vault pays for `amount` of the reward token, given the attested rate
    /// in stablecoin per 10¹² reward units. Rounded down: the market never pays more than
    /// its own price.
    pub fn quote(&self, amount: u64, stable_per_trillion_reward: u64) -> Result<u64> {
        // One division at the end, so the spread does not round a second time.
        let stable = u128::from(amount)
            .checked_mul(u128::from(stable_per_trillion_reward))
            .and_then(|value| value.checked_mul(BPS - u128::from(self.spread_bps)))
            .ok_or_else(|| error!(RewardFloatError::MathOverflow))?
            / (RATE_DENOMINATOR * BPS);
        u64::try_from(stable).map_err(|_| error!(RewardFloatError::MathOverflow))
    }

    /// The fewest reward units this vault pays at least `stable` for, at the attested rate:
    /// the inverse of [`Self::quote`]. Saturates at `u64::MAX`, since it only ever caps what
    /// a sweep withholds, and no reward account holds more than that.
    pub fn tokens_for(&self, stable: u64, stable_per_trillion_reward: u64) -> u64 {
        // Below 2⁶⁴ · 10¹⁶ and 2⁶⁴ · 10⁴, so neither side overflows a u128.
        let tokens = (u128::from(stable) * RATE_DENOMINATOR * BPS)
            .div_ceil(u128::from(stable_per_trillion_reward) * (BPS - u128::from(self.spread_bps)));
        u64::try_from(tokens).unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values worked out in Python, apart from this implementation:
    // amount · rate · (10 000 − spread) // (10¹² · 10 000).
    const HONEY_AT_0_0023: u64 = 2_300_000;
    const HNT_AT_3_10: u64 = 31_000_000_000;

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
    fn the_layout_is_the_one_we_declared() {
        // pool, reward_mint, stable_vault, reward_vault 4 · 32 + 2 · u16 + bump 1
        assert_eq!(ConversionVault::INIT_SPACE, 133);
    }

    #[test]
    fn it_quotes_the_attested_rate_less_its_spread() {
        // 1234.567890123 HONEY (9 decimals) at $0.0023 is $2.839506; 30 bps less is $2.830987.
        assert_eq!(
            vault(30).quote(1_234_567_890_123, HONEY_AT_0_0023).unwrap(),
            2_830_987
        );
        // 50 HNT (8 decimals) at $3.10 is $155; 30 bps less is $154.535.
        assert_eq!(
            vault(30).quote(5_000_000_000, HNT_AT_3_10).unwrap(),
            154_535_000
        );
    }

    #[test]
    fn without_a_spread_it_pays_the_attested_rate() {
        assert_eq!(
            vault(0).quote(1_234_567_890_123, HONEY_AT_0_0023).unwrap(),
            2_839_506
        );
        assert_eq!(
            vault(0).quote(5_000_000_000, HNT_AT_3_10).unwrap(),
            155_000_000
        );
    }

    #[test]
    fn it_rounds_down_to_the_unit_the_market_can_pay() {
        // 333 units at 3·10⁹ per 10¹² are worth 0.999 of a stablecoin unit.
        assert_eq!(vault(0).quote(333, 3_000_000_000).unwrap(), 0);
        assert_eq!(vault(1).quote(1, 1_000_000_000_000).unwrap(), 0);
        assert_eq!(vault(0).quote(0, HONEY_AT_0_0023).unwrap(), 0);
    }

    #[test]
    fn the_widest_spread_still_quotes_without_overflow() {
        assert_eq!(
            vault(9_999).quote(u64::MAX, 1_000_000_000_000).unwrap(),
            1_844_674_407_370_955
        );
    }

    #[test]
    fn it_finds_the_fewest_units_that_pay_a_stablecoin_amount() {
        // 50 HNT buy exactly $154.535 at a 30 bps spread, and one unit less does not.
        assert_eq!(
            vault(30).tokens_for(154_535_000, HNT_AT_3_10),
            5_000_000_000
        );
        assert_eq!(
            vault(30).tokens_for(2_830_987, HONEY_AT_0_0023),
            1_234_567_615_892
        );
        assert_eq!(vault(0).tokens_for(1, 2_406_662), 415_514);
    }

    #[test]
    fn what_it_finds_is_paid_in_full_and_one_unit_less_is_not() {
        for (stable, rate, spread) in [
            (2_830_987, HONEY_AT_0_0023, 30),
            (102_465_753, 2_406_662, 30),
            (1, HONEY_AT_0_0023, 30),
            (154_535_001, HNT_AT_3_10, 30),
        ] {
            let vault = vault(spread);
            let tokens = vault.tokens_for(stable, rate);
            assert!(vault.quote(tokens, rate).unwrap() >= stable);
            assert!(vault.quote(tokens - 1, rate).unwrap() < stable);
        }
    }

    #[test]
    fn nothing_is_bought_with_no_tokens() {
        assert_eq!(vault(30).tokens_for(0, HONEY_AT_0_0023), 0);
    }

    #[test]
    fn a_unit_worth_more_than_the_amount_is_still_one_unit() {
        assert_eq!(vault(0).tokens_for(1, 1_000_000_000_000_000), 1);
    }

    #[test]
    fn more_units_than_an_account_can_hold_saturate() {
        assert_eq!(vault(9_999).tokens_for(u64::MAX, 1), u64::MAX);
    }

    #[test]
    fn a_quote_beyond_what_the_arithmetic_holds_is_refused() {
        let err = vault(0).quote(u64::MAX, u64::MAX).unwrap_err();
        assert_eq!(code(err), code(error!(RewardFloatError::MathOverflow)));
    }
}
