mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use common::{account, custom, m, metas, mollusk, token_account, track, wallet, LAMPORTS_PER_SOL};
use mollusk_svm::result::InstructionResult;
use reward_float::error::RewardFloatError;
use reward_float::{
    LenderShare, Loan, LoanStatus, Pool, LOAN_SEED, POOL_SEED, REPAYMENT_PERIOD, SECONDS_PER_YEAR,
    SHARE_SEED, VAULT_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;

const NOW: i64 = 1_790_157_600;
const DEPOSITS: u64 = 1_000_000_000;
const BORROWED: u64 = 100_000_000;
const BOOKED_INTEREST: u64 = 2_000_000;
// 10 % on BORROWED for the year since the loan was last touched.
const UNBOOKED_INTEREST: u64 = 10_000_000;
const VAULT: u64 = DEPOSITS - BORROWED;
const WALLET: u64 = 500_000_000;

fn refused_by_anchor(code: anchor_lang::error::ErrorCode) -> Result<(), InstructionError> {
    Err(InstructionError::Custom(code.into()))
}

fn program_account(data: Vec<u8>) -> Account {
    Account {
        lamports: LAMPORTS_PER_SOL,
        data,
        owner: m(&reward_float::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn serialize(state: &impl AccountSerialize) -> Vec<u8> {
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    data
}

fn deserialize<T: AccountDeserialize>(result: &InstructionResult, key: &Pubkey) -> T {
    T::try_deserialize(&mut account(result, key).data.as_slice()).unwrap()
}

fn token_balance(result: &InstructionResult, key: &Pubkey) -> u64 {
    spl_token::state::Account::unpack(&account(result, key).data)
        .unwrap()
        .amount
}

fn share_pda(pool: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SHARE_SEED, pool.as_ref(), owner.as_ref()],
        &reward_float::ID,
    )
}

struct Setup {
    lender: Pubkey,
    lender_signs: bool,
    stable_mint: Pubkey,
    pool: Pubkey,
    pool_state: Pool,
    vault: Pubkey,
    lender_share: Pubkey,
    share_state: Option<LenderShare>,
    source: Pubkey,
    source_mint: Pubkey,
    source_owner: Pubkey,
    amount: u64,
}

impl Setup {
    fn empty_pool() -> Self {
        let lender = Pubkey::new_unique();
        let stable_mint = Pubkey::new_unique();
        let (pool, pool_bump) =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID);
        let vault = Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0;
        Self {
            lender,
            lender_signs: true,
            stable_mint,
            pool,
            pool_state: Pool {
                authority: Pubkey::new_unique(),
                attestor: Pubkey::new_unique(),
                stable_mint,
                vault,
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
                bump: pool_bump,
            },
            vault,
            lender_share: share_pda(&pool, &lender).0,
            share_state: None,
            source: Pubkey::new_unique(),
            source_mint: stable_mint,
            source_owner: lender,
            amount: 250_000_000,
        }
    }

    // A pool lent out in part, with one loan nobody has touched for a year: some of its
    // interest is booked, the year since is not.
    fn pool_with_a_loan() -> Self {
        let mut setup = Self::empty_pool();
        let operator = Pubkey::new_unique();
        let loan = Loan {
            operator,
            pool: setup.pool,
            reward_mint: Pubkey::new_unique(),
            nonce: 1,
            principal: BORROWED,
            outstanding: BORROWED,
            accrued_interest: BOOKED_INTEREST,
            interest_remainder: 0,
            opened_at: NOW - SECONDS_PER_YEAR,
            due_at: NOW - SECONDS_PER_YEAR + 6 * REPAYMENT_PERIOD,
            last_accrual_at: NOW - SECONDS_PER_YEAR,
            apr_bps: 1_000,
            sweep_bps: 5_000,
            status: LoanStatus::Active,
            reward_due: 0,
            manual_repayment: None,
            bump: Pubkey::find_program_address(
                &[LOAN_SEED, operator.as_ref(), &1u64.to_le_bytes()],
                &reward_float::ID,
            )
            .1,
        };
        let pool = &mut setup.pool_state;
        pool.total_shares = DEPOSITS;
        pool.total_deposits = DEPOSITS;
        pool.total_borrowed = BORROWED;
        pool.accrued_interest = BOOKED_INTEREST;
        track(pool, &loan);
        setup
    }

    fn instruction(&self) -> Instruction {
        let mut accounts = metas(
            reward_float::accounts::Deposit {
                lender: self.lender,
                pool: self.pool,
                lender_share: self.lender_share,
                vault: self.vault,
                source: self.source,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        accounts[0].is_signer = self.lender_signs;
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::Deposit {
                amount: self.amount,
            }
            .data(),
        }
    }

    fn run(&self) -> InstructionResult {
        let share = match &self.share_state {
            Some(state) => program_account(serialize(state)),
            None => Account::default(),
        };
        let vault = self.pool_state.total_deposits - self.pool_state.total_borrowed;
        let accounts = vec![
            (m(&self.lender), wallet()),
            (m(&self.pool), program_account(serialize(&self.pool_state))),
            (m(&self.lender_share), share),
            (
                m(&self.vault),
                token_account(&self.stable_mint, &self.pool, vault),
            ),
            (
                m(&self.source),
                token_account(&self.source_mint, &self.source_owner, WALLET),
            ),
            mollusk_svm_programs_token::token::keyed_account(),
            mollusk_svm::program::keyed_account_for_system_program(),
        ];
        let mut mollusk = mollusk();
        mollusk.sysvars.clock.unix_timestamp = NOW;
        mollusk.process_instruction(&self.instruction(), &accounts)
    }
}

#[test]
fn the_first_deposit_opens_the_share_account_one_share_per_unit() {
    let setup = Setup::empty_pool();
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    println!("deposit, first: {} CU", result.compute_units_consumed);
    assert!(result.compute_units_consumed <= 30_000);

    assert_eq!(token_balance(&result, &setup.source), WALLET - 250_000_000);
    assert_eq!(token_balance(&result, &setup.vault), 250_000_000);

    let share: LenderShare = deserialize(&result, &setup.lender_share);
    assert_eq!(
        serialize(&share),
        serialize(&LenderShare {
            pool: setup.pool,
            owner: setup.lender,
            shares: 250_000_000,
            bump: share_pda(&setup.pool, &setup.lender).1,
        })
    );

    let mut pool = setup.pool_state.clone();
    pool.total_shares = 250_000_000;
    pool.total_deposits = 250_000_000;
    assert_eq!(
        serialize(&deserialize::<Pool>(&result, &setup.pool)),
        serialize(&pool)
    );
}

#[test]
fn a_share_costs_what_the_pool_is_worth_this_second() {
    let mut setup = Setup::pool_with_a_loan();
    // The pool is worth DEPOSITS + both kinds of interest, 1012 USDC for 1000 shares:
    // 253 USDC buy a quarter of that.
    setup.amount = 253_000_000;
    assert_eq!(
        DEPOSITS + BOOKED_INTEREST + UNBOOKED_INTEREST,
        4 * setup.amount
    );
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    println!(
        "deposit, into a lent pool: {} CU",
        result.compute_units_consumed
    );
    assert!(result.compute_units_consumed <= 30_000);

    let share: LenderShare = deserialize(&result, &setup.lender_share);
    assert_eq!(share.shares, DEPOSITS / 4);
    assert_eq!(token_balance(&result, &setup.vault), VAULT + setup.amount);

    // Nothing is booked by a deposit: the loan's interest stays where it was.
    let mut pool = setup.pool_state.clone();
    pool.total_shares = DEPOSITS + DEPOSITS / 4;
    pool.total_deposits = DEPOSITS + setup.amount;
    assert_eq!(
        serialize(&deserialize::<Pool>(&result, &setup.pool)),
        serialize(&pool)
    );
}

#[test]
fn a_second_deposit_adds_to_the_same_share_account() {
    let mut setup = Setup::empty_pool();
    setup.pool_state.total_shares = 400_000_000;
    setup.pool_state.total_deposits = 400_000_000;
    let (_, bump) = share_pda(&setup.pool, &setup.lender);
    setup.share_state = Some(LenderShare {
        pool: setup.pool,
        owner: setup.lender,
        shares: 100_000_000,
        bump,
    });
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    let share: LenderShare = deserialize(&result, &setup.lender_share);
    assert_eq!(share.shares, 350_000_000);
    assert_eq!((share.owner, share.bump), (setup.lender, bump));
    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!(pool.total_shares, 650_000_000);
}

#[test]
fn a_deposit_worth_less_than_one_share_is_refused() {
    let mut setup = Setup::pool_with_a_loan();
    setup.amount = 1;
    let result = setup.run();
    assert_eq!(result.raw_result, custom(RewardFloatError::DepositTooSmall));
}

#[test]
fn a_deposit_of_nothing_is_refused() {
    let mut setup = Setup::empty_pool();
    setup.amount = 0;
    let result = setup.run();
    assert_eq!(result.raw_result, custom(RewardFloatError::InvalidAmount));
}

#[test]
fn more_than_the_lender_holds_is_refused_by_the_token_program() {
    let mut setup = Setup::empty_pool();
    setup.amount = WALLET + 1;
    let result = setup.run();
    let insufficient = spl_token::error::TokenError::InsufficientFunds as u32;
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(insufficient))
    );
}

#[test]
fn the_lender_has_to_sign() {
    let mut setup = Setup::empty_pool();
    setup.lender_signs = false;
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::AccountNotSigner)
    );
}

#[test]
fn the_lender_cannot_spend_from_someone_else_s_account() {
    let mut setup = Setup::empty_pool();
    setup.source_owner = Pubkey::new_unique();
    let result = setup.run();
    let owner_mismatch = spl_token::error::TokenError::OwnerMismatch as u32;
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(owner_mismatch))
    );
}

#[test]
fn deposits_come_in_only_in_the_pool_stablecoin() {
    let mut setup = Setup::empty_pool();
    setup.source_mint = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintTokenMint)
    );
}

#[test]
fn a_vault_other_than_the_pool_s_is_refused() {
    let mut setup = Setup::empty_pool();
    setup.vault = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintHasOne)
    );
}

#[test]
fn shares_go_only_to_the_signing_lender_s_account() {
    let mut setup = Setup::empty_pool();
    setup.lender_share = share_pda(&setup.pool, &Pubkey::new_unique()).0;
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintSeeds)
    );
}
