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

    pub fn initialize_pool(ctx: Context<InitializePool>, attestor: Pubkey) -> Result<()> {
        handle_initialize_pool(ctx, attestor)
    }
}
