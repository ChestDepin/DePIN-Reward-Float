// What the program last saw on an operator's reward account. A payout is an earlier
// transaction the program never sees, so the part of a sweep's balance that arrived since
// is the only payout it can measure without trusting a number from outside (FR-015).
use anchor_lang::prelude::*;

/// Seed prefix of the reward watch PDA: `["watch", operator, reward_mint]`.
pub const WATCH_SEED: &[u8] = b"watch";

#[account]
#[derive(InitSpace)]
pub struct RewardWatch {
    pub operator: Pubkey,
    pub reward_mint: Pubkey,
    // Balance of the operator's associated reward account right after the last sweep, or
    // at the loan that started the watch. Whatever is above it is a payout not yet swept.
    pub balance: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // operator, reward_mint 2 · 32 + balance 8 + bump 1
        assert_eq!(RewardWatch::INIT_SPACE, 73);
    }
}
