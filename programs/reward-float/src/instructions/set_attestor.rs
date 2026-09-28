use anchor_lang::prelude::*;

use crate::error::RewardFloatError;
use crate::state::Pool;

#[derive(Accounts)]
pub struct SetAttestor<'info> {
    // The pool authority rather than the upgrade authority: the key stays replaceable
    // even after the program is made immutable.
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority @ RewardFloatError::NotPoolAuthority)]
    pub pool: Account<'info, Pool>,
}

pub fn handle_set_attestor(ctx: Context<SetAttestor>, attestor: Pubkey) -> Result<()> {
    require_keys_neq!(
        attestor,
        Pubkey::default(),
        RewardFloatError::InvalidAttestor
    );
    ctx.accounts.pool.attestor = attestor;
    Ok(())
}
