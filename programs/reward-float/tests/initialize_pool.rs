use std::sync::Once;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use reward_float::error::RewardFloatError;
use reward_float::{Pool, POOL_SEED, VAULT_SEED};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::{AccountMeta, Instruction};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

static SBF_OUT_DIR: Once = Once::new();

// Mollusk looks for the .so in tests/fixtures, $SBF_OUT_DIR and the cwd, never in
// target/deploy, and `cargo test -p` runs from the package directory. It also does not
// build it: after touching src/, run `anchor build` first or this tests the old bytecode.
fn mollusk() -> Mollusk {
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
fn m(key: &Pubkey) -> solana_pubkey::Pubkey {
    solana_pubkey::Pubkey::new_from_array(key.to_bytes())
}

fn wallet() -> Account {
    Account::new(10 * LAMPORTS_PER_SOL, 0, &solana_pubkey::Pubkey::default())
}

fn mint_account() -> Account {
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

fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

// Only the metadata header: bincode of UpgradeableLoaderState::ProgramData, that is a
// u32 variant tag (3), the u64 deploy slot and an Option<Pubkey>. The ELF that follows
// it on chain is irrelevant to the instruction and mollusk runs from its own cache.
fn program_data_account(upgrade_authority: Option<Pubkey>) -> Account {
    let mut data = vec![3, 0, 0, 0];
    data.extend_from_slice(&0u64.to_le_bytes());
    match upgrade_authority {
        Some(key) => {
            data.push(1);
            data.extend_from_slice(key.as_ref());
        }
        None => data.push(0),
    }
    Account {
        lamports: LAMPORTS_PER_SOL,
        data,
        owner: m(&bpf_loader_upgradeable::ID),
        executable: false,
        rent_epoch: 0,
    }
}

struct Setup {
    signer: Pubkey,
    upgrade_authority: Pubkey,
    stable_mint: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    program_data: Pubkey,
    attestor: Pubkey,
}

impl Setup {
    fn by_upgrade_authority() -> Self {
        let upgrade_authority = Pubkey::new_unique();
        let stable_mint = Pubkey::new_unique();
        let pool =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID).0;
        Self {
            signer: upgrade_authority,
            upgrade_authority,
            stable_mint,
            pool,
            vault: Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0,
            program_data: program_data_address(&reward_float::ID),
            attestor: Pubkey::new_unique(),
        }
    }

    fn instruction(&self) -> Instruction {
        let metas = reward_float::accounts::InitializePool {
            authority: self.signer,
            pool: self.pool,
            stable_mint: self.stable_mint,
            vault: self.vault,
            program_data: self.program_data,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None)
        .into_iter()
        .map(|meta| AccountMeta {
            pubkey: m(&meta.pubkey),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect();
        Instruction {
            program_id: m(&reward_float::ID),
            accounts: metas,
            data: reward_float::instruction::InitializePool {
                attestor: self.attestor,
            }
            .data(),
        }
    }

    fn accounts(&self) -> Vec<(solana_pubkey::Pubkey, Account)> {
        vec![
            (m(&self.signer), wallet()),
            (m(&self.pool), Account::default()),
            (m(&self.stable_mint), mint_account()),
            (m(&self.vault), Account::default()),
            (
                m(&self.program_data),
                program_data_account(Some(self.upgrade_authority)),
            ),
            mollusk_svm_programs_token::token::keyed_account(),
            mollusk_svm::program::keyed_account_for_system_program(),
        ]
    }

    fn run(&self) -> InstructionResult {
        mollusk().process_instruction(&self.instruction(), &self.accounts())
    }
}

fn account<'a>(result: &'a InstructionResult, key: &Pubkey) -> &'a Account {
    result.get_account(&m(key)).unwrap()
}

fn custom(err: RewardFloatError) -> Result<(), InstructionError> {
    Err(InstructionError::Custom(err.into()))
}

#[test]
fn the_upgrade_authority_creates_an_empty_pool_with_its_vault() {
    let setup = Setup::by_upgrade_authority();
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    let pool = Pool::try_deserialize(&mut account(&result, &setup.pool).data.as_slice()).unwrap();
    assert_eq!(pool.authority, setup.upgrade_authority);
    assert_eq!(pool.attestor, setup.attestor);
    assert_eq!(pool.stable_mint, setup.stable_mint);
    assert_eq!(pool.vault, setup.vault);
    assert_eq!(pool.total_shares, 0);
    assert_eq!(pool.total_deposits, 0);
    assert_eq!(pool.total_borrowed, 0);
    assert_eq!(pool.accrued_interest, 0);
    assert_eq!(pool.overdue_principal, 0);
    let (_, bump) =
        Pubkey::find_program_address(&[POOL_SEED, setup.stable_mint.as_ref()], &reward_float::ID);
    assert_eq!(pool.bump, bump);

    let vault_account = account(&result, &setup.vault);
    assert_eq!(vault_account.owner, m(&spl_token::ID));
    let vault = spl_token::state::Account::unpack(&vault_account.data).unwrap();
    assert_eq!(vault.mint, setup.stable_mint);
    // The pool PDA, not the authority: nobody holding a key can move lenders' money.
    assert_eq!(vault.owner, setup.pool);
    assert_eq!(vault.amount, 0);
    assert_eq!(vault.delegate, COption::None);
    assert_eq!(vault.close_authority, COption::None);
}

#[test]
fn a_signer_that_is_not_the_upgrade_authority_is_refused() {
    let mut setup = Setup::by_upgrade_authority();
    setup.signer = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        custom(RewardFloatError::NotUpgradeAuthority)
    );
}

#[test]
fn program_data_of_another_program_is_refused() {
    // Anyone can deploy a program of their own and be its upgrade authority. If the
    // program data account were taken on trust, that would be enough to own the pool
    // for a mint, and with it the attestor key.
    let mut setup = Setup::by_upgrade_authority();
    setup.signer = Pubkey::new_unique();
    setup.upgrade_authority = setup.signer;
    setup.program_data = program_data_address(&Pubkey::new_unique());
    let result = setup.run();
    let seeds: u32 = anchor_lang::error::ErrorCode::ConstraintSeeds.into();
    assert_eq!(result.raw_result, Err(InstructionError::Custom(seeds)));
}

#[test]
fn a_second_pool_for_the_same_mint_cannot_be_created() {
    let setup = Setup::by_upgrade_authority();
    let first = setup.run();
    assert_eq!(first.raw_result, Ok(()));

    let mut accounts = setup.accounts();
    for (key, account) in accounts.iter_mut() {
        if let Some(after) = first.get_account(key) {
            *account = after.clone();
        }
    }
    let second = mollusk().process_instruction(&setup.instruction(), &accounts);
    // SystemError::AccountAlreadyInUse, from creating the pool account a second time.
    assert_eq!(second.raw_result, Err(InstructionError::Custom(0)));
}
