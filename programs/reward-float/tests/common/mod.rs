// Every test binary compiles its own copy of this module and uses only part of it.
#![allow(dead_code)]

use std::sync::Once;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use reward_float::error::RewardFloatError;
use reward_float::{Loan, Pool};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::AccountMeta;

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

static SBF_OUT_DIR: Once = Once::new();

// Mollusk looks for the .so in tests/fixtures, $SBF_OUT_DIR and the cwd, never in
// target/deploy, and `cargo test -p` runs from the package directory. It also does not
// build it: after touching src/, run `anchor build` first or this tests the old bytecode.
pub fn mollusk() -> Mollusk {
    SBF_OUT_DIR.call_once(|| {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy");
        assert!(
            std::path::Path::new(dir).join("reward_float.so").exists(),
            "{dir}/reward_float.so is missing: run scripts/wsl-build.sh first"
        );
        std::env::set_var("SBF_OUT_DIR", dir);
    });
    let mut mollusk = Mollusk::new(&m(&reward_float::ID), "reward_float");
    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk
}

// anchor-lang 0.32 and mollusk 0.15 link different solana-pubkey majors.
pub fn m(key: &Pubkey) -> solana_pubkey::Pubkey {
    solana_pubkey::Pubkey::new_from_array(key.to_bytes())
}

pub fn metas(metas: Vec<anchor_lang::prelude::AccountMeta>) -> Vec<AccountMeta> {
    metas
        .into_iter()
        .map(|meta| AccountMeta {
            pubkey: m(&meta.pubkey),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect()
}

pub fn wallet() -> Account {
    Account::new(10 * LAMPORTS_PER_SOL, 0, &solana_pubkey::Pubkey::default())
}

pub fn account<'a>(result: &'a InstructionResult, key: &Pubkey) -> &'a Account {
    result.get_account(&m(key)).unwrap()
}

pub fn custom(err: RewardFloatError) -> Result<(), InstructionError> {
    Err(InstructionError::Custom(err.into()))
}

pub fn mint_account() -> Account {
    let mut data = vec![0; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(
        spl_token::state::Mint {
            mint_authority: COption::Some(Pubkey::new_unique()),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    Account {
        lamports: LAMPORTS_PER_SOL,
        data,
        owner: m(&spl_token::ID),
        executable: false,
        rent_epoch: 0,
    }
}

pub fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(
        spl_token::state::Account {
            mint: *mint,
            owner: *owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    Account {
        lamports: LAMPORTS_PER_SOL,
        data,
        owner: m(&spl_token::ID),
        executable: false,
        rent_epoch: 0,
    }
}

// Adds an open loan to the pool's accrual sums, worked out here rather than by the
// program, so that a test setting a pool up does not lean on the code under test.
pub fn track(pool: &mut Pool, loan: &Loan) {
    let rate = u128::from(loan.outstanding) * u128::from(loan.apr_bps);
    pool.accrual_rate += rate;
    pool.accrual_rate_time += rate * u128::try_from(loan.last_accrual_at).unwrap();
    pool.accrual_remainders += u128::from(loan.interest_remainder);
}
