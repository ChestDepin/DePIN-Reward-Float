mod common;

use std::cell::RefCell;
use std::rc::Rc;

use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{
    AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use anchor_spl::token::spl_token;
use common::{account, custom, m, metas, mollusk, token_account, track, wallet, LAMPORTS_PER_SOL};
use mollusk_svm::result::InstructionResult;
use reward_float::error::RewardFloatError;
use reward_float::instructions::Withdrawn;
use reward_float::{
    LenderShare, Loan, LoanStatus, Pool, WithdrawalLimit, LOAN_SEED, POOL_SEED, REPAYMENT_PERIOD,
    SECONDS_PER_YEAR, SHARE_SEED, VAULT_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;
use solana_svm_log_collector::LogCollector;

const NOW: i64 = 1_790_157_600;
const DEPOSITS: u64 = 1_000_000_000;
const BOOKED_INTEREST: u64 = 2_000_000;
// A quarter of the pool's shares.
const SHARES: u64 = 250_000_000;

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

struct Run {
    result: InstructionResult,
    logs: Vec<String>,
}

impl Run {
    fn withdrawn(&self) -> Vec<Withdrawn> {
        self.logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .map(|data| STANDARD.decode(data).unwrap())
            .filter(|data| data.starts_with(Withdrawn::DISCRIMINATOR))
            .map(|data| Withdrawn::try_from_slice(&data[Withdrawn::DISCRIMINATOR.len()..]).unwrap())
            .collect()
    }
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
    destination: Pubkey,
    destination_mint: Pubkey,
    max_amount: u64,
}

impl Setup {
    // A pool of 1000 USDC with `borrowed` of it in one loan nobody has touched for a year
    // at 10 %: some of its interest is booked, the year since is not. The lender holds a
    // quarter of the shares.
    fn lent(borrowed: u64) -> Self {
        let lender = Pubkey::new_unique();
        let stable_mint = Pubkey::new_unique();
        let (pool, pool_bump) =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID);
        let vault = Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0;
        let operator = Pubkey::new_unique();
        let loan = Loan {
            operator,
            pool,
            reward_mint: Pubkey::new_unique(),
            nonce: 1,
            principal: borrowed,
            outstanding: borrowed,
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
        let mut pool_state = Pool {
            authority: Pubkey::new_unique(),
            attestor: Pubkey::new_unique(),
            stable_mint,
            vault,
            total_shares: DEPOSITS,
            total_deposits: DEPOSITS,
            total_borrowed: borrowed,
            accrued_interest: BOOKED_INTEREST,
            accrual_rate: 0,
            accrual_rate_time: 0,
            accrual_remainders: 0,
            overdue_principal: 0,
            base_apr_bps: 800,
            slope_apr_bps: 2_000,
            bump: pool_bump,
        };
        track(&mut pool_state, &loan);
        let (lender_share, bump) = share_pda(&pool, &lender);
        Self {
            lender,
            lender_signs: true,
            stable_mint,
            pool,
            pool_state,
            vault,
            lender_share,
            share_state: Some(LenderShare {
                pool,
                owner: lender,
                shares: SHARES,
                bump,
            }),
            destination: Pubkey::new_unique(),
            destination_mint: stable_mint,
            max_amount: 1_000_000,
        }
    }

    // The pool is worth 1012 USDC for 1000 shares, and the lender's quarter 253.
    fn partly_lent() -> Self {
        Self::lent(100_000_000)
    }

    fn instruction(&self) -> Instruction {
        let mut accounts = metas(
            reward_float::accounts::Withdraw {
                lender: self.lender,
                pool: self.pool,
                lender_share: self.lender_share,
                vault: self.vault,
                destination: self.destination,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        );
        accounts[0].is_signer = self.lender_signs;
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::Withdraw {
                max_amount: self.max_amount,
            }
            .data(),
        }
    }

    fn vault_balance(&self) -> u64 {
        self.pool_state.total_deposits - self.pool_state.total_borrowed
    }

    fn run(&self) -> Run {
        let share = match &self.share_state {
            Some(state) => program_account(serialize(state)),
            None => Account::default(),
        };
        let accounts = vec![
            (m(&self.lender), wallet()),
            (m(&self.pool), program_account(serialize(&self.pool_state))),
            (m(&self.lender_share), share),
            (
                m(&self.vault),
                token_account(&self.stable_mint, &self.pool, self.vault_balance()),
            ),
            (
                m(&self.destination),
                token_account(&self.destination_mint, &self.lender, 0),
            ),
            mollusk_svm_programs_token::token::keyed_account(),
        ];
        let mut mollusk = mollusk();
        mollusk.sysvars.clock.unix_timestamp = NOW;
        let logger = Rc::new(RefCell::new(LogCollector::default()));
        mollusk.logger = Some(logger.clone());
        let result = mollusk.process_instruction(&self.instruction(), &accounts);
        let logs = logger.borrow().get_recorded_content().to_vec();
        Run { result, logs }
    }

    fn event(
        &self,
        paid: u64,
        shares_burned: u64,
        limited_by: Option<WithdrawalLimit>,
    ) -> Withdrawn {
        Withdrawn {
            pool: self.pool,
            lender: self.lender,
            requested: self.max_amount,
            paid,
            shares_burned,
            limited_by,
        }
    }
}

fn same(left: &Withdrawn, right: &Withdrawn) -> bool {
    (
        left.pool,
        left.lender,
        left.requested,
        left.paid,
        left.shares_burned,
        left.limited_by,
    ) == (
        right.pool,
        right.lender,
        right.requested,
        right.paid,
        right.shares_burned,
        right.limited_by,
    )
}

#[test]
fn a_withdrawal_pays_what_was_asked_and_burns_the_shares_it_is_worth() {
    let mut setup = Setup::partly_lent();
    // Half of what the lender's quarter is worth, interest earned this second included.
    setup.max_amount = 126_500_000;
    let run = setup.run();
    let result = &run.result;
    assert_eq!(result.raw_result, Ok(()));
    println!("withdraw, part: {} CU", result.compute_units_consumed);
    assert!(result.compute_units_consumed <= 30_000);

    assert_eq!(token_balance(result, &setup.destination), 126_500_000);
    assert_eq!(
        token_balance(result, &setup.vault),
        setup.vault_balance() - 126_500_000
    );
    let share: LenderShare = deserialize(result, &setup.lender_share);
    assert_eq!(share.shares, SHARES / 2);

    // Nothing is booked by a withdrawal: the loan's interest stays where it was.
    let mut pool = setup.pool_state.clone();
    pool.total_shares = DEPOSITS - SHARES / 2;
    pool.total_deposits = DEPOSITS - 126_500_000;
    assert_eq!(
        serialize(&deserialize::<Pool>(result, &setup.pool)),
        serialize(&pool)
    );

    let events = run.withdrawn();
    assert_eq!(events.len(), 1);
    assert!(same(
        &events[0],
        &setup.event(126_500_000, SHARES / 2, None)
    ));
}

#[test]
fn asking_for_everything_pays_out_the_whole_position() {
    let mut setup = Setup::partly_lent();
    setup.max_amount = u64::MAX;
    let run = setup.run();
    let result = &run.result;
    assert_eq!(result.raw_result, Ok(()));
    println!("withdraw, all: {} CU", result.compute_units_consumed);
    assert!(result.compute_units_consumed <= 30_000);

    assert_eq!(token_balance(result, &setup.destination), 253_000_000);
    let share: LenderShare = deserialize(result, &setup.lender_share);
    assert_eq!(share.shares, 0);
    let pool: Pool = deserialize(result, &setup.pool);
    assert_eq!(
        (pool.total_shares, pool.total_deposits),
        (DEPOSITS - SHARES, DEPOSITS - 253_000_000)
    );
    assert!(same(
        &run.withdrawn()[0],
        &setup.event(253_000_000, SHARES, Some(WithdrawalLimit::Position))
    ));
}

#[test]
fn a_withdrawal_past_the_free_liquidity_pays_what_is_free_and_says_why() {
    // 900 USDC out in loans, 100 free. The pool is worth 1092 USDC, the lender's quarter 273.
    let mut setup = Setup::lent(900_000_000);
    setup.max_amount = 273_000_000;
    let run = setup.run();
    let result = &run.result;
    assert_eq!(result.raw_result, Ok(()));

    assert_eq!(token_balance(result, &setup.destination), 100_000_000);
    assert_eq!(token_balance(result, &setup.vault), 0);
    // 100 · 1000 / 1092 = 91.575091… shares, rounded up.
    let burned = 91_575_092;
    let share: LenderShare = deserialize(result, &setup.lender_share);
    assert_eq!(share.shares, SHARES - burned);
    let pool: Pool = deserialize(result, &setup.pool);
    assert_eq!(pool.total_deposits, pool.total_borrowed);
    assert!(same(
        &run.withdrawn()[0],
        &setup.event(100_000_000, burned, Some(WithdrawalLimit::FreeLiquidity))
    ));
}

#[test]
fn a_pool_with_nothing_free_explains_instead_of_paying_nothing() {
    let setup = Setup::lent(DEPOSITS);
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        custom(RewardFloatError::NoFreeLiquidity)
    );
    assert!(run.withdrawn().is_empty());
}

#[test]
fn a_lender_whose_shares_are_all_withdrawn_is_refused() {
    let mut setup = Setup::partly_lent();
    if let Some(share) = setup.share_state.as_mut() {
        share.shares = 0;
    }
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        custom(RewardFloatError::NothingToWithdraw)
    );
}

#[test]
fn a_lender_who_never_deposited_has_no_share_account() {
    let mut setup = Setup::partly_lent();
    setup.share_state = None;
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::AccountNotInitialized)
    );
}

#[test]
fn a_withdrawal_of_nothing_is_refused() {
    let mut setup = Setup::partly_lent();
    setup.max_amount = 0;
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        custom(RewardFloatError::InvalidAmount)
    );
}

#[test]
fn the_lender_has_to_sign() {
    let mut setup = Setup::partly_lent();
    setup.lender_signs = false;
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::AccountNotSigner)
    );
}

#[test]
fn a_lender_cannot_withdraw_someone_else_s_shares() {
    let mut setup = Setup::partly_lent();
    let other = Pubkey::new_unique();
    let (address, bump) = share_pda(&setup.pool, &other);
    setup.lender_share = address;
    setup.share_state = Some(LenderShare {
        pool: setup.pool,
        owner: other,
        shares: SHARES,
        bump,
    });
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintSeeds)
    );
}

#[test]
fn withdrawals_go_out_only_in_the_pool_stablecoin() {
    let mut setup = Setup::partly_lent();
    setup.destination_mint = Pubkey::new_unique();
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintTokenMint)
    );
}

#[test]
fn a_vault_other_than_the_pool_s_is_refused() {
    let mut setup = Setup::partly_lent();
    setup.vault = Pubkey::new_unique();
    let run = setup.run();
    assert_eq!(
        run.result.raw_result,
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintHasOne)
    );
}
