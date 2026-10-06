mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use common::{account, custom, m, metas, mint_account, mollusk, wallet, LAMPORTS_PER_SOL};
use mollusk_svm::result::InstructionResult;
use reward_float::error::RewardFloatError;
use reward_float::{
    ConversionVault, Pool, CONVERSION_REWARD_SEED, CONVERSION_SEED, CONVERSION_STABLE_SEED,
    POOL_SEED, VAULT_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;

fn pool_account(pool: &Pool) -> Account {
    let mut data = Vec::new();
    pool.try_serialize(&mut data).unwrap();
    Account {
        lamports: LAMPORTS_PER_SOL,
        data,
        owner: m(&reward_float::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn derive(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &reward_float::ID).0
}

struct Setup {
    signer: Pubkey,
    pool_authority: Pubkey,
    stable_mint: Pubkey,
    pool: Pubkey,
    reward_mint: Pubkey,
    stable_mint_passed: Pubkey,
    spread_bps: u16,
    max_slippage_bps: u16,
}

impl Setup {
    fn by_pool_authority() -> Self {
        let pool_authority = Pubkey::new_unique();
        let stable_mint = Pubkey::new_unique();
        Self {
            signer: pool_authority,
            pool_authority,
            stable_mint,
            pool: derive(&[POOL_SEED, stable_mint.as_ref()]),
            reward_mint: Pubkey::new_unique(),
            stable_mint_passed: stable_mint,
            spread_bps: 30,
            max_slippage_bps: 100,
        }
    }

    fn conversion_vault(&self) -> Pubkey {
        derive(&[
            CONVERSION_SEED,
            self.pool.as_ref(),
            self.reward_mint.as_ref(),
        ])
    }

    fn stable_vault(&self) -> Pubkey {
        derive(&[CONVERSION_STABLE_SEED, self.conversion_vault().as_ref()])
    }

    fn reward_vault(&self) -> Pubkey {
        derive(&[CONVERSION_REWARD_SEED, self.conversion_vault().as_ref()])
    }

    fn pool_state(&self) -> Pool {
        Pool {
            authority: self.pool_authority,
            attestor: Pubkey::new_unique(),
            stable_mint: self.stable_mint,
            vault: derive(&[VAULT_SEED, self.pool.as_ref()]),
            total_shares: 0,
            total_deposits: 0,
            total_borrowed: 0,
            accrued_interest: 0,
            accrual_rate: 0,
            accrual_rate_time: 0,
            accrual_remainders: 0,
            overdue_principal: 0,
            base_apr_bps: 800,
            slope_apr_bps: 2_000,
            bump: 255,
        }
    }

    fn instruction(&self) -> Instruction {
        let accounts = reward_float::accounts::InitConversionVault {
            authority: self.signer,
            pool: self.pool,
            conversion_vault: self.conversion_vault(),
            reward_mint: self.reward_mint,
            stable_mint: self.stable_mint_passed,
            stable_vault: self.stable_vault(),
            reward_vault: self.reward_vault(),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None);
        Instruction {
            program_id: m(&reward_float::ID),
            accounts: metas(accounts),
            data: reward_float::instruction::InitConversionVault {
                spread_bps: self.spread_bps,
                max_slippage_bps: self.max_slippage_bps,
            }
            .data(),
        }
    }

    fn accounts(&self) -> Vec<(solana_pubkey::Pubkey, Account)> {
        let mut accounts = vec![
            (m(&self.signer), wallet()),
            (m(&self.pool), pool_account(&self.pool_state())),
            (m(&self.conversion_vault()), Account::default()),
            (m(&self.reward_mint), mint_account()),
            (m(&self.stable_vault()), Account::default()),
            (m(&self.reward_vault()), Account::default()),
            mollusk_svm_programs_token::token::keyed_account(),
            mollusk_svm::program::keyed_account_for_system_program(),
        ];
        if self.stable_mint_passed != self.reward_mint {
            accounts.push((m(&self.stable_mint_passed), mint_account()));
        }
        accounts
    }

    fn run(&self) -> InstructionResult {
        mollusk().process_instruction(&self.instruction(), &self.accounts())
    }
}

fn token_state(result: &InstructionResult, key: &Pubkey) -> spl_token::state::Account {
    let raw = account(result, key);
    assert_eq!(raw.owner, m(&spl_token::ID));
    spl_token::state::Account::unpack(&raw.data).unwrap()
}

#[test]
fn the_pool_authority_creates_a_vault_with_both_token_accounts() {
    let setup = Setup::by_pool_authority();
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    let vault = ConversionVault::try_deserialize(
        &mut account(&result, &setup.conversion_vault()).data.as_slice(),
    )
    .unwrap();
    assert_eq!(vault.pool, setup.pool);
    assert_eq!(vault.reward_mint, setup.reward_mint);
    assert_eq!(vault.stable_vault, setup.stable_vault());
    assert_eq!(vault.reward_vault, setup.reward_vault());
    assert_eq!(vault.spread_bps, 30);
    assert_eq!(vault.max_slippage_bps, 100);
    let (_, bump) = Pubkey::find_program_address(
        &[
            CONVERSION_SEED,
            setup.pool.as_ref(),
            setup.reward_mint.as_ref(),
        ],
        &reward_float::ID,
    );
    assert_eq!(vault.bump, bump);

    // Both owned by the vault PDA, so only the program can move what is in them.
    let stable = token_state(&result, &setup.stable_vault());
    assert_eq!(stable.mint, setup.stable_mint);
    assert_eq!(stable.owner, setup.conversion_vault());
    assert_eq!(stable.amount, 0);
    assert_eq!(stable.delegate, COption::None);
    assert_eq!(stable.close_authority, COption::None);

    let reward = token_state(&result, &setup.reward_vault());
    assert_eq!(reward.mint, setup.reward_mint);
    assert_eq!(reward.owner, setup.conversion_vault());
    assert_eq!(reward.amount, 0);
    assert_eq!(reward.delegate, COption::None);
    assert_eq!(reward.close_authority, COption::None);
}

#[test]
fn a_signer_that_is_not_the_pool_authority_is_refused() {
    let mut setup = Setup::by_pool_authority();
    setup.signer = Pubkey::new_unique();
    assert_eq!(
        setup.run().raw_result,
        custom(RewardFloatError::NotPoolAuthority)
    );
}

#[test]
fn a_stablecoin_other_than_the_pools_is_refused() {
    // A vault paying out another stablecoin could never repay a loan of this pool.
    let mut setup = Setup::by_pool_authority();
    setup.stable_mint_passed = Pubkey::new_unique();
    let address: u32 = anchor_lang::error::ErrorCode::ConstraintAddress.into();
    assert_eq!(
        setup.run().raw_result,
        Err(InstructionError::Custom(address))
    );
}

#[test]
fn the_pools_own_stablecoin_cannot_be_the_reward_token() {
    let mut setup = Setup::by_pool_authority();
    setup.reward_mint = setup.stable_mint;
    assert_eq!(
        setup.run().raw_result,
        custom(RewardFloatError::RewardMintIsStablecoin)
    );
}

#[test]
fn a_spread_that_leaves_nothing_to_pay_is_refused() {
    let mut setup = Setup::by_pool_authority();
    setup.spread_bps = 10_000;
    assert_eq!(
        setup.run().raw_result,
        custom(RewardFloatError::InvalidConversionTerms)
    );

    setup.spread_bps = 9_999;
    assert_eq!(setup.run().raw_result, Ok(()));
}

#[test]
fn a_tolerance_that_accepts_any_loss_is_refused() {
    // FR-015a rules out a loss-making conversion; at 10 000 bps a quote of zero would pass.
    let mut setup = Setup::by_pool_authority();
    setup.max_slippage_bps = 10_000;
    assert_eq!(
        setup.run().raw_result,
        custom(RewardFloatError::InvalidConversionTerms)
    );

    setup.max_slippage_bps = 0;
    assert_eq!(setup.run().raw_result, Ok(()));
}

#[test]
fn a_second_vault_for_the_same_pool_and_reward_token_cannot_be_created() {
    let setup = Setup::by_pool_authority();
    let first = setup.run();
    assert_eq!(first.raw_result, Ok(()));

    let mut accounts = setup.accounts();
    for (key, account) in accounts.iter_mut() {
        if let Some(after) = first.get_account(key) {
            *account = after.clone();
        }
    }
    let second = mollusk().process_instruction(&setup.instruction(), &accounts);
    // SystemError::AccountAlreadyInUse, from creating the vault account a second time.
    assert_eq!(second.raw_result, Err(InstructionError::Custom(0)));
}

#[test]
fn another_reward_token_of_the_same_pool_gets_a_vault_of_its_own() {
    let honey = Setup::by_pool_authority();
    let mut hnt = Setup::by_pool_authority();
    hnt.pool_authority = honey.pool_authority;
    hnt.signer = honey.signer;
    hnt.stable_mint = honey.stable_mint;
    hnt.stable_mint_passed = honey.stable_mint;
    hnt.pool = honey.pool;
    assert_ne!(honey.conversion_vault(), hnt.conversion_vault());
    assert_eq!(honey.run().raw_result, Ok(()));
    assert_eq!(hnt.run().raw_result, Ok(()));
}
