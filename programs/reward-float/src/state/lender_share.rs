// One lender's claim on a pool (FR-018), counted in shares rather than in stablecoin so
// that interest reaches every lender without anyone's account being touched (FR-018a).
use anchor_lang::prelude::*;

/// Seed prefix of the lender share PDA: `["share", pool, owner]`.
pub const SHARE_SEED: &[u8] = b"share";

#[account]
#[derive(InitSpace)]
pub struct LenderShare {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_is_the_one_we_declared() {
        // pool 32 + owner 32 + shares 8 + bump 1
        assert_eq!(LenderShare::INIT_SPACE, 73);
    }
}
