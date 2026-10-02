// Програма reward-float: пул, позики, утримання з винагород.
// Інструкції наповнюються у Фазі 4 — склад і порядок у docs/TASKS.md.
//
// Ліміт оператора ця програма НЕ рахує: він приходить підписаною атестацією
// і перевіряється через Ed25519-інструкцію в тій самій транзакції (FR-012a).
use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

use instructions::*;
pub use state::*;

declare_id!("RewardFLoat11111111111111111111111111111111");

#[program]
pub mod reward_float {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        attestor: Pubkey,
        base_apr_bps: u16,
        slope_apr_bps: u16,
    ) -> Result<()> {
        handle_initialize_pool(ctx, attestor, base_apr_bps, slope_apr_bps)
    }

    pub fn set_attestor(ctx: Context<SetAttestor>, attestor: Pubkey) -> Result<()> {
        handle_set_attestor(ctx, attestor)
    }

    pub fn borrow(
        ctx: Context<Borrow>,
        nonce: u64,
        amount: u64,
        term_periods: u8,
        sweep_bps: u16,
        max_apr_bps: u16,
    ) -> Result<()> {
        handle_borrow(ctx, nonce, amount, term_periods, sweep_bps, max_apr_bps)
    }

    pub fn repay(ctx: Context<Repay>, max_amount: u64) -> Result<()> {
        handle_repay(ctx, max_amount)
    }
}
