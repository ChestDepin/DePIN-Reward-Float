use std::sync::Once;

use anchor_lang::prelude::Pubkey;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use reward_float::error::RewardFloatError;
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
