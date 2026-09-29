mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use common::{account, custom, m, metas, mint_account, mollusk, wallet, LAMPORTS_PER_SOL};
use mollusk_svm::result::InstructionResult;
use reward_float::error::RewardFloatError;
use reward_float::{Pool, POOL_SEED, VAULT_SEED};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;

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
    base_apr_bps: u16,
    slope_apr_bps: u16,
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
            base_apr_bps: 800,
            slope_apr_bps: 2_000,
        }
    }

    fn instruction(&self) -> Instruction {
        let accounts = reward_float::accounts::InitializePool {
            authority: self.signer,
            pool: self.pool,
            stable_mint: self.stable_mint,
            vault: self.vault,
            program_data: self.program_data,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None);
        Instruction {
            program_id: m(&reward_float::ID),
            accounts: metas(accounts),
            data: reward_float::instruction::InitializePool {
                attestor: self.attestor,
                base_apr_bps: self.base_apr_bps,
                slope_apr_bps: self.slope_apr_bps,
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
    assert_eq!(pool.base_apr_bps, 800);
    assert_eq!(pool.slope_apr_bps, 2_000);
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
fn a_rate_curve_whose_top_does_not_fit_in_u16_is_refused() {
    // A full pool would quote base + slope, and a rate that does not fit the loan's
    // u16 field would fail every borrow near the top instead of failing here, once.
    let mut setup = Setup::by_upgrade_authority();
    setup.base_apr_bps = 1;
    setup.slope_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        custom(RewardFloatError::InvalidRateCurve)
    );

    setup.base_apr_bps = 0;
    assert_eq!(setup.run().raw_result, Ok(()));
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
