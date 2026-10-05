mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use common::{account, custom, m, metas, mollusk, wallet, LAMPORTS_PER_SOL};
use mollusk_svm::result::InstructionResult;
use reward_float::error::RewardFloatError;
use reward_float::Pool;
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;

fn pool_state(authority: Pubkey, attestor: Pubkey) -> Pool {
    Pool {
        authority,
        attestor,
        stable_mint: Pubkey::new_unique(),
        vault: Pubkey::new_unique(),
        total_shares: 7,
        total_deposits: 1_000_000,
        total_borrowed: 400_000,
        accrued_interest: 1_234,
        accrual_rate: 11,
        accrual_rate_time: 13,
        accrual_remainders: 17,
        overdue_principal: 5,
        base_apr_bps: 800,
        slope_apr_bps: 2_000,
        bump: 254,
    }
}

fn serialize(pool: &Pool) -> Vec<u8> {
    let mut data = Vec::new();
    pool.try_serialize(&mut data).unwrap();
    data
}

struct Setup {
    signer: Pubkey,
    signs: bool,
    pool: Pubkey,
    state: Pool,
    new_attestor: Pubkey,
}

impl Setup {
    fn by_pool_authority() -> Self {
        let authority = Pubkey::new_unique();
        Self {
            signer: authority,
            signs: true,
            pool: Pubkey::new_unique(),
            state: pool_state(authority, Pubkey::new_unique()),
            new_attestor: Pubkey::new_unique(),
        }
    }

    fn instruction(&self) -> Instruction {
        let mut accounts = metas(
            reward_float::accounts::SetAttestor {
                authority: self.signer,
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        accounts[0].is_signer = self.signs;
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::SetAttestor {
                attestor: self.new_attestor,
            }
            .data(),
        }
    }

    fn run(&self) -> InstructionResult {
        let pool = Account {
            lamports: LAMPORTS_PER_SOL,
            data: serialize(&self.state),
            owner: m(&reward_float::ID),
            executable: false,
            rent_epoch: 0,
        };
        mollusk().process_instruction(
            &self.instruction(),
            &[(m(&self.signer), wallet()), (m(&self.pool), pool)],
        )
    }
}

#[test]
fn the_pool_authority_replaces_the_attestor_and_nothing_else() {
    let setup = Setup::by_pool_authority();
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    let data = &account(&result, &setup.pool).data;
    let pool = Pool::try_deserialize(&mut data.as_slice()).unwrap();
    assert_eq!(pool.attestor, setup.new_attestor);
    let mut expected = pool_state(setup.state.authority, setup.new_attestor);
    expected.stable_mint = setup.state.stable_mint;
    expected.vault = setup.state.vault;
    assert_eq!(*data, serialize(&expected));
}

#[test]
fn a_signer_that_is_not_the_pool_authority_is_refused() {
    let mut setup = Setup::by_pool_authority();
    setup.signer = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        custom(RewardFloatError::NotPoolAuthority)
    );
}

#[test]
fn the_pool_authority_has_to_sign() {
    let mut setup = Setup::by_pool_authority();
    setup.signs = false;
    let result = setup.run();
    let not_signer: u32 = anchor_lang::error::ErrorCode::AccountNotSigner.into();
    assert_eq!(result.raw_result, Err(InstructionError::Custom(not_signer)));
}

#[test]
fn the_zero_key_is_refused_as_an_attestor() {
    // Almost certainly a client bug, and a small-order point on ed25519: whether the
    // precompile accepts signatures for it depends on strict verification.
    let mut setup = Setup::by_pool_authority();
    setup.new_attestor = Pubkey::default();
    let result = setup.run();
    assert_eq!(result.raw_result, custom(RewardFloatError::InvalidAttestor));
}
