mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use common::{account, custom, m, metas, mollusk, token_account, track, wallet, LAMPORTS_PER_SOL};
use mollusk_svm::result::InstructionResult;
use reward_float::error::RewardFloatError;
use reward_float::{
    Loan, LoanStatus, OperatorAccount, Pool, LOAN_SEED, OPERATOR_SEED, POOL_SEED, REPAYMENT_PERIOD,
    SECONDS_PER_YEAR, VAULT_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;

const NOW: i64 = 1_790_157_600;
const DEPOSITS: u64 = 1_000_000_000;
const PRINCIPAL: u64 = 100_000_000;
const OUTSTANDING: u64 = 60_000_000;
const INTEREST: u64 = 2_000_000;
const OWED: u64 = OUTSTANDING + INTEREST;
const VAULT: u64 = DEPOSITS - OUTSTANDING;
const WALLET: u64 = 100_000_000;

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

fn operator_pda(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[OPERATOR_SEED, owner.as_ref()], &reward_float::ID)
}

struct Setup {
    payer: Pubkey,
    payer_signs: bool,
    stable_mint: Pubkey,
    pool: Pubkey,
    pool_state: Pool,
    vault: Pubkey,
    loan: Pubkey,
    loan_state: Loan,
    operator_account: Pubkey,
    operator_state: OperatorAccount,
    source: Pubkey,
    source_mint: Pubkey,
    source_owner: Pubkey,
    max_amount: u64,
}

impl Setup {
    // One open loan, 40 % of it repaid already and some interest accrued on the rest,
    // with every book agreeing on it.
    fn open_loan() -> Self {
        let operator = Pubkey::new_unique();
        let stable_mint = Pubkey::new_unique();
        let (pool, pool_bump) =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID);
        let vault = Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0;
        let (loan, loan_bump) = Pubkey::find_program_address(
            &[LOAN_SEED, operator.as_ref(), &7u64.to_le_bytes()],
            &reward_float::ID,
        );
        let (operator_account, operator_bump) = operator_pda(&operator);
        Self {
            payer: operator,
            payer_signs: true,
            stable_mint,
            pool,
            pool_state: Pool {
                authority: Pubkey::new_unique(),
                attestor: Pubkey::new_unique(),
                stable_mint,
                vault,
                total_shares: DEPOSITS,
                total_deposits: DEPOSITS,
                total_borrowed: OUTSTANDING,
                accrued_interest: INTEREST,
                // Filled in from the loan as it stands when the test runs.
                accrual_rate: 0,
                accrual_rate_time: 0,
                accrual_remainders: 0,
                overdue_principal: 0,
                base_apr_bps: 800,
                slope_apr_bps: 2_000,
                bump: pool_bump,
            },
            vault,
            loan,
            loan_state: Loan {
                operator,
                pool,
                reward_mint: Pubkey::new_unique(),
                nonce: 7,
                principal: PRINCIPAL,
                outstanding: OUTSTANDING,
                accrued_interest: INTEREST,
                interest_remainder: 0,
                opened_at: NOW - 40 * 86_400,
                due_at: NOW - 40 * 86_400 + 3 * REPAYMENT_PERIOD,
                last_accrual_at: NOW,
                apr_bps: 1_000,
                sweep_bps: 5_000,
                status: LoanStatus::Active,
                reward_due: 0,
                manual_repayment: None,
                bump: loan_bump,
            },
            operator_account,
            operator_state: OperatorAccount {
                owner: operator,
                total_debt: OWED,
                open_loans: 1,
                overdue: false,
                nonce_floor: 0,
                used_nonces: [1 << 7, 0, 0, 0],
                bump: operator_bump,
            },
            source: Pubkey::new_unique(),
            source_mint: stable_mint,
            source_owner: operator,
            max_amount: 30_000_000,
        }
    }

    fn instruction(&self) -> Instruction {
        let mut accounts = metas(
            reward_float::accounts::Repay {
                payer: self.payer,
                pool: self.pool,
                loan: self.loan,
                operator_account: self.operator_account,
                vault: self.vault,
                source: self.source,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        );
        accounts[0].is_signer = self.payer_signs;
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::Repay {
                max_amount: self.max_amount,
            }
            .data(),
        }
    }

    fn run(&self) -> InstructionResult {
        let mut pool = self.pool_state.clone();
        if self.loan_state.is_open() {
            track(&mut pool, &self.loan_state);
        }
        let accounts = vec![
            (m(&self.payer), wallet()),
            (m(&self.pool), program_account(serialize(&pool))),
            (m(&self.loan), program_account(serialize(&self.loan_state))),
            (
                m(&self.operator_account),
                program_account(serialize(&self.operator_state)),
            ),
            (
                m(&self.vault),
                token_account(&self.stable_mint, &self.pool, VAULT),
            ),
            (
                m(&self.source),
                token_account(&self.source_mint, &self.source_owner, WALLET),
            ),
            mollusk_svm_programs_token::token::keyed_account(),
        ];
        let mut mollusk = mollusk();
        mollusk.sysvars.clock.unix_timestamp = NOW;
        mollusk.process_instruction(&self.instruction(), &accounts)
    }
}

#[test]
fn a_partial_repayment_settles_interest_first_and_moves_every_book() {
    let setup = Setup::open_loan();
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    println!("repay, partial: {} CU", result.compute_units_consumed);
    assert!(result.compute_units_consumed <= 20_000);

    assert_eq!(token_balance(&result, &setup.source), WALLET - 30_000_000);
    assert_eq!(token_balance(&result, &setup.vault), VAULT + 30_000_000);

    let mut loan = setup.loan_state.clone();
    loan.accrued_interest = 0;
    loan.outstanding = OUTSTANDING - 28_000_000;
    assert_eq!(
        serialize(&deserialize::<Loan>(&result, &setup.loan)),
        serialize(&loan)
    );

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account);
    assert_eq!(operator.total_debt, OWED - 30_000_000);
    assert_eq!(operator.open_loans, 1);

    let mut pool = setup.pool_state.clone();
    pool.total_borrowed = OUTSTANDING - 28_000_000;
    pool.accrued_interest = 0;
    // Interest actually paid in is the pool's income, and it is cash now.
    pool.total_deposits = DEPOSITS + INTEREST;
    // The loan stays on the accrual sums with what is left of it.
    track(&mut pool, &loan);
    assert_eq!(
        serialize(&deserialize::<Pool>(&result, &setup.pool)),
        serialize(&pool)
    );
}

#[test]
fn more_than_the_debt_takes_exactly_the_debt_and_repays_the_loan() {
    let mut setup = Setup::open_loan();
    setup.max_amount = WALLET;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    assert_eq!(token_balance(&result, &setup.source), WALLET - OWED);
    assert_eq!(token_balance(&result, &setup.vault), VAULT + OWED);

    let loan: Loan = deserialize(&result, &setup.loan);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!((loan.outstanding, loan.accrued_interest), (0, 0));
    assert_eq!(loan.principal, PRINCIPAL, "the terms stay on record");

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account);
    assert_eq!((operator.total_debt, operator.open_loans), (0, 0));

    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!((pool.total_borrowed, pool.accrued_interest), (0, 0));
    assert_eq!(pool.total_deposits, DEPOSITS + INTEREST);
    // A repaid loan earns nothing more, so nothing of it is left on the accrual sums.
    assert_eq!(
        (
            pool.accrual_rate,
            pool.accrual_rate_time,
            pool.accrual_remainders
        ),
        (0, 0, 0)
    );
}

#[test]
fn exactly_the_debt_repays_the_loan() {
    let mut setup = Setup::open_loan();
    setup.max_amount = OWED;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    let loan: Loan = deserialize(&result, &setup.loan);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(token_balance(&result, &setup.source), WALLET - OWED);
}

#[test]
fn repaying_one_loan_leaves_the_operator_s_other_loans_open() {
    let mut setup = Setup::open_loan();
    setup.operator_state.total_debt = OWED + 50_000_000;
    setup.operator_state.open_loans = 2;
    setup.pool_state.total_borrowed = OUTSTANDING + 50_000_000;
    setup.max_amount = OWED;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account);
    assert_eq!((operator.total_debt, operator.open_loans), (50_000_000, 1));
    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!(pool.total_borrowed, 50_000_000);
}

#[test]
fn anyone_may_repay_on_the_operator_s_behalf() {
    let mut setup = Setup::open_loan();
    let stranger = Pubkey::new_unique();
    setup.payer = stranger;
    setup.source_owner = stranger;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    let loan: Loan = deserialize(&result, &setup.loan);
    assert_eq!(loan.outstanding, OUTSTANDING - 28_000_000);
    assert_eq!(loan.operator, setup.loan_state.operator);
}

#[test]
fn the_payer_cannot_spend_from_someone_else_s_account() {
    let mut setup = Setup::open_loan();
    setup.payer = Pubkey::new_unique();
    let result = setup.run();
    let owner_mismatch = spl_token::error::TokenError::OwnerMismatch as u32;
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(owner_mismatch))
    );
}

#[test]
fn the_payer_has_to_sign() {
    let mut setup = Setup::open_loan();
    setup.payer_signs = false;
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::AccountNotSigner)
    );
}

#[test]
fn a_repayment_of_nothing_is_refused() {
    let mut setup = Setup::open_loan();
    setup.max_amount = 0;
    let result = setup.run();
    assert_eq!(result.raw_result, custom(RewardFloatError::InvalidAmount));
}

#[test]
fn a_repaid_loan_takes_no_more_money() {
    let mut setup = Setup::open_loan();
    setup.loan_state.outstanding = 0;
    setup.loan_state.accrued_interest = 0;
    setup.loan_state.status = LoanStatus::Repaid;
    setup.operator_state.total_debt = 0;
    setup.operator_state.open_loans = 0;
    let result = setup.run();
    assert_eq!(result.raw_result, custom(RewardFloatError::LoanNotOpen));
}

#[test]
fn an_overdue_loan_can_still_be_repaid() {
    let mut setup = Setup::open_loan();
    setup.loan_state.status = LoanStatus::Overdue;
    setup.max_amount = OWED;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));
    let loan: Loan = deserialize(&result, &setup.loan);
    assert_eq!(loan.status, LoanStatus::Repaid);
}

#[test]
fn repayment_comes_in_only_in_the_pool_stablecoin() {
    let mut setup = Setup::open_loan();
    setup.source_mint = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintTokenMint)
    );
}

#[test]
fn a_vault_other_than_the_pool_s_is_refused() {
    let mut setup = Setup::open_loan();
    setup.vault = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintHasOne)
    );
}

#[test]
fn a_loan_of_another_pool_is_refused() {
    let mut setup = Setup::open_loan();
    setup.loan_state.pool = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintHasOne)
    );
}

#[test]
fn the_debt_comes_off_the_loan_operator_s_account_only() {
    let mut setup = Setup::open_loan();
    let someone_else = Pubkey::new_unique();
    let (address, bump) = operator_pda(&someone_else);
    setup.operator_account = address;
    setup.operator_state.owner = someone_else;
    setup.operator_state.bump = bump;
    let result = setup.run();
    assert_eq!(
        result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintSeeds)
    );
}

// A year since the loan was last touched: 10 % of what is outstanding is owed on top.
const A_YEAR_OF_INTEREST: u64 = OUTSTANDING / 10;

#[test]
fn interest_accrued_since_the_loan_was_last_touched_is_settled_first() {
    let mut setup = Setup::open_loan();
    setup.loan_state.last_accrual_at = NOW - SECONDS_PER_YEAR;
    setup.max_amount = 10_000_000;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    let interest = INTEREST + A_YEAR_OF_INTEREST;
    let loan: Loan = deserialize(&result, &setup.loan);
    assert_eq!(loan.accrued_interest, 0);
    assert_eq!(loan.outstanding, OUTSTANDING - (10_000_000 - interest));
    assert_eq!(loan.last_accrual_at, NOW);

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account);
    assert_eq!(operator.total_debt, OWED + A_YEAR_OF_INTEREST - 10_000_000);

    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!(pool.accrued_interest, 0);
    assert_eq!(pool.total_borrowed, loan.outstanding);
    assert_eq!(pool.total_deposits, DEPOSITS + interest);
}

#[test]
fn repaying_in_full_includes_interest_up_to_this_second() {
    let mut setup = Setup::open_loan();
    setup.loan_state.last_accrual_at = NOW - SECONDS_PER_YEAR;
    setup.max_amount = WALLET;
    let result = setup.run();
    assert_eq!(result.raw_result, Ok(()));

    let owed = OWED + A_YEAR_OF_INTEREST;
    assert_eq!(token_balance(&result, &setup.source), WALLET - owed);
    let loan: Loan = deserialize(&result, &setup.loan);
    assert_eq!(loan.status, LoanStatus::Repaid);
    let operator: OperatorAccount = deserialize(&result, &setup.operator_account);
    assert_eq!((operator.total_debt, operator.open_loans), (0, 0));
    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!((pool.total_borrowed, pool.accrued_interest), (0, 0));
}
