mod common;

use std::cell::RefCell;
use std::rc::Rc;

use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{
    AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::spl_token;
use common::{m, metas, mollusk, token_account, track, LAMPORTS_PER_SOL};
use ed25519_dalek::{Signer, SigningKey};
use mollusk_svm::result::types::{TransactionProgramResult, TransactionResult};
use reward_float::error::RewardFloatError;
use reward_float::instructions::verify_attestation::RATE_ATTESTATION_TAG;
use reward_float::instructions::{SweepSkipped, Swept};
use reward_float::{
    ConversionVault, Loan, LoanStatus, OperatorAccount, Pool, RewardWatch, CONVERSION_REWARD_SEED,
    CONVERSION_SEED, CONVERSION_STABLE_SEED, LOAN_SEED, NONCE_WINDOW_WORDS, OPERATOR_SEED,
    POOL_SEED, REPAYMENT_PERIOD, VAULT_SEED, WATCH_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::{AccountMeta, Instruction};
use solana_sdk_ids::{ed25519_program, sysvar};
use solana_svm_log_collector::LogCollector;

// Every expected number below was worked out in Python, apart from the code under test:
// quote = withheld · rate · (10⁴ − spread) // 10¹⁶, the fewest units paying x =
// ceil(x · 10¹⁶ / (rate · (10⁴ − spread))), deviation rounded up.
const NOW: i64 = 1_790_157_600;
const DEPOSITS: u64 = 1_000_000_000;
// $3.10 per HNT, which has 8 decimals: stablecoin units per 10¹² reward units.
const RATE: u64 = 31_000_000_000;
const OUTSTANDING: u64 = 100_000_000;
// On the account before the payout, which the watch already saw.
const HELD: u64 = 250_000_000;
// 10 HNT.
const PAYOUT: u64 = 1_000_000_000;
const ALLOWANCE: u64 = 4_000_000_000;
const CONVERSION_STABLE: u64 = 10_000_000_000;
const SPREAD: u16 = 30;
const TOLERANCE: u16 = 100;
// Half of the payout, and what the vault pays for it 30 bps under the attested rate.
const HALF: u64 = 500_000_000;
const HALF_PAID: u64 = 15_453_500;

// The sweep comes right after the ed25519 check of its rate.
const SWEEP: usize = 1;

type Outcome = Result<(), (usize, InstructionError)>;

fn outcome(result: &TransactionResult) -> Outcome {
    match &result.program_result {
        TransactionProgramResult::Success => Ok(()),
        TransactionProgramResult::Failure(at, err) => {
            Err((*at, InstructionError::from(u64::from(err.clone()))))
        }
        TransactionProgramResult::UnknownError(at, err) => Err((*at, err.clone())),
    }
}

fn refused(err: RewardFloatError) -> Outcome {
    Err((SWEEP, InstructionError::Custom(err.into())))
}

fn refused_by_anchor(code: anchor_lang::error::ErrorCode) -> Outcome {
    Err((SWEEP, InstructionError::Custom(code.into())))
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

fn ed25519_instruction(signer: &SigningKey, message: &[u8]) -> Instruction {
    let signature = signer.sign(message).to_bytes();
    let public_key_at: u16 = 16;
    let signature_at = public_key_at + 32;
    let message_at = signature_at + 64;
    let mut data = vec![1, 0];
    for field in [
        signature_at,
        u16::MAX,
        public_key_at,
        u16::MAX,
        message_at,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&field.to_le_bytes());
    }
    data.extend_from_slice(signer.verifying_key().as_bytes());
    data.extend_from_slice(&signature);
    data.extend_from_slice(message);
    Instruction {
        program_id: m(&ed25519_program::ID),
        accounts: vec![],
        data,
    }
}

fn reward_token_account(
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    delegate: Option<(Pubkey, u64)>,
) -> Account {
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(
        spl_token::state::Account {
            mint: *mint,
            owner: *owner,
            amount,
            delegate: delegate.map_or(COption::None, |(key, _)| COption::Some(key)),
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: delegate.map_or(0, |(_, amount)| amount),
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

struct Run {
    result: TransactionResult,
    logs: Vec<String>,
}

impl Run {
    fn outcome(&self) -> Outcome {
        outcome(&self.result)
    }

    fn state<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let account = self.result.get_account(&m(key)).unwrap();
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn token(&self, key: &Pubkey) -> spl_token::state::Account {
        spl_token::state::Account::unpack(&self.result.get_account(&m(key)).unwrap().data).unwrap()
    }

    fn events<E: AnchorDeserialize + Discriminator>(&self) -> Vec<E> {
        self.logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .map(|data| STANDARD.decode(data).unwrap())
            .filter(|data| data.starts_with(E::DISCRIMINATOR))
            .map(|data| E::try_from_slice(&data[E::DISCRIMINATOR.len()..]).unwrap())
            .collect()
    }
}

struct Setup {
    attestor: SigningKey,
    stable_mint: Pubkey,
    reward_mint: Pubkey,
    pool: Pubkey,
    pool_state: Pool,
    vault: Pubkey,
    operator: Pubkey,
    loans: Vec<Loan>,
    // Loans passed after the named accounts; every open loan of the operator unless a
    // test says otherwise.
    passed: Option<Vec<Pubkey>>,
    reward_account: Pubkey,
    reward_balance: u64,
    delegate: Option<(Pubkey, u64)>,
    watch_balance: u64,
    conversion_vault: Pubkey,
    conversion_state: ConversionVault,
    rate_mint: Pubkey,
    rate_check: bool,
    sweeps: usize,
}

impl Setup {
    // One open loan on HNT, half of every payout withheld, a payout of 10 HNT on the
    // reward account since the watch last saw it.
    fn payout() -> Self {
        let operator = Pubkey::new_unique();
        let attestor = SigningKey::from_bytes(&[1; 32]);
        let stable_mint = Pubkey::new_unique();
        let reward_mint = Pubkey::new_unique();
        let (pool, pool_bump) =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID);
        let vault = Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0;
        let (conversion_vault, conversion_bump) = Pubkey::find_program_address(
            &[CONVERSION_SEED, pool.as_ref(), reward_mint.as_ref()],
            &reward_float::ID,
        );
        let stable_vault = Pubkey::find_program_address(
            &[CONVERSION_STABLE_SEED, conversion_vault.as_ref()],
            &reward_float::ID,
        )
        .0;
        let reward_vault = Pubkey::find_program_address(
            &[CONVERSION_REWARD_SEED, conversion_vault.as_ref()],
            &reward_float::ID,
        )
        .0;
        let mut setup = Self {
            attestor: attestor.clone(),
            stable_mint,
            reward_mint,
            pool,
            pool_state: Pool {
                authority: Pubkey::new_unique(),
                attestor: Pubkey::new_from_array(attestor.verifying_key().to_bytes()),
                stable_mint,
                vault,
                total_shares: DEPOSITS,
                total_deposits: DEPOSITS,
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
            operator,
            loans: Vec::new(),
            passed: None,
            reward_account: get_associated_token_address(&operator, &reward_mint),
            reward_balance: HELD + PAYOUT,
            delegate: None,
            watch_balance: HELD,
            conversion_vault,
            conversion_state: ConversionVault {
                pool,
                reward_mint,
                stable_vault,
                reward_vault,
                spread_bps: SPREAD,
                max_slippage_bps: TOLERANCE,
                bump: conversion_bump,
            },
            rate_mint: reward_mint,
            rate_check: true,
            sweeps: 1,
        };
        setup.delegate = Some((setup.operator_account(), ALLOWANCE));
        setup.loans.push(setup.loan(1, OUTSTANDING, 5_000));
        setup
    }

    fn operator_account(&self) -> Pubkey {
        Pubkey::find_program_address(&[OPERATOR_SEED, self.operator.as_ref()], &reward_float::ID).0
    }

    fn watch(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[
                WATCH_SEED,
                self.operator.as_ref(),
                self.reward_mint.as_ref(),
            ],
            &reward_float::ID,
        )
        .0
    }

    fn loan_at(&self, nonce: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[LOAN_SEED, self.operator.as_ref(), &nonce.to_le_bytes()],
            &reward_float::ID,
        )
    }

    fn address(&self, index: usize) -> Pubkey {
        self.loan_at(self.loans[index].nonce).0
    }

    // Opened a day before NOW, nonce by nonce, with interest up to date at NOW.
    fn loan(&self, nonce: u64, outstanding: u64, sweep_bps: u16) -> Loan {
        let opened_at = NOW - 86_400 + nonce as i64;
        Loan {
            operator: self.operator,
            pool: self.pool,
            reward_mint: self.reward_mint,
            nonce,
            principal: outstanding,
            outstanding,
            accrued_interest: 0,
            interest_remainder: 0,
            opened_at,
            due_at: opened_at + 3 * REPAYMENT_PERIOD,
            last_accrual_at: NOW,
            apr_bps: 1_000,
            sweep_bps,
            status: LoanStatus::Active,
            bump: self.loan_at(nonce).1,
        }
    }

    fn instruction(&self) -> Instruction {
        let mut accounts = metas(
            reward_float::accounts::Sweep {
                pool: self.pool,
                operator_account: self.operator_account(),
                reward_account: self.reward_account,
                reward_watch: self.watch(),
                conversion_vault: self.conversion_vault,
                stable_vault: self.conversion_state.stable_vault,
                reward_vault: self.conversion_state.reward_vault,
                vault: self.vault,
                instructions: sysvar::instructions::ID,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        );
        let passed = self.passed.clone().unwrap_or_else(|| {
            (0..self.loans.len())
                .map(|index| self.address(index))
                .collect()
        });
        accounts.extend(passed.iter().map(|loan| AccountMeta {
            pubkey: m(loan),
            is_signer: false,
            is_writable: true,
        }));
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::Sweep {}.data(),
        }
    }

    fn rate(&self) -> Instruction {
        let mut message = RATE_ATTESTATION_TAG.to_vec();
        message.extend_from_slice(self.rate_mint.as_ref());
        message.extend_from_slice(&RATE.to_le_bytes());
        message.extend_from_slice(&(NOW - 30).to_le_bytes());
        message.extend_from_slice(&(NOW + 90).to_le_bytes());
        ed25519_instruction(&self.attestor, &message)
    }

    fn run(&self) -> Run {
        let mut pool = self.pool_state.clone();
        let mut operator = OperatorAccount {
            owner: self.operator,
            total_debt: 0,
            open_loans: 0,
            overdue: false,
            nonce_floor: 0,
            used_nonces: [0; NONCE_WINDOW_WORDS],
            bump: Pubkey::find_program_address(
                &[OPERATOR_SEED, self.operator.as_ref()],
                &reward_float::ID,
            )
            .1,
        };
        for loan in &self.loans {
            track(&mut pool, loan);
            pool.total_borrowed += loan.outstanding;
            pool.accrued_interest += loan.accrued_interest;
            operator.total_debt += loan.outstanding + loan.accrued_interest;
            operator.open_loans += 1;
        }
        let watch = RewardWatch {
            operator: self.operator,
            reward_mint: self.reward_mint,
            balance: self.watch_balance,
            bump: Pubkey::find_program_address(
                &[
                    WATCH_SEED,
                    self.operator.as_ref(),
                    self.reward_mint.as_ref(),
                ],
                &reward_float::ID,
            )
            .1,
        };
        let state = &self.conversion_state;
        let mut accounts = vec![
            (m(&self.pool), program_account(serialize(&pool))),
            (
                m(&self.operator_account()),
                program_account(serialize(&operator)),
            ),
            (
                m(&self.reward_account),
                reward_token_account(
                    &self.reward_mint,
                    &self.operator,
                    self.reward_balance,
                    self.delegate,
                ),
            ),
            (m(&self.watch()), program_account(serialize(&watch))),
            (m(&self.conversion_vault), program_account(serialize(state))),
            (
                m(&state.stable_vault),
                token_account(&self.stable_mint, &self.conversion_vault, CONVERSION_STABLE),
            ),
            (
                m(&state.reward_vault),
                token_account(&self.reward_mint, &self.conversion_vault, 0),
            ),
            (
                m(&self.vault),
                token_account(
                    &self.stable_mint,
                    &self.pool,
                    DEPOSITS - pool.total_borrowed,
                ),
            ),
            mollusk_svm_programs_token::token::keyed_account(),
        ];
        for (index, loan) in self.loans.iter().enumerate() {
            accounts.push((m(&self.address(index)), program_account(serialize(loan))));
        }
        let mut instructions = Vec::new();
        for _ in 0..self.sweeps {
            if self.rate_check {
                instructions.push(self.rate());
            }
            instructions.push(self.instruction());
        }
        let mut mollusk = mollusk();
        mollusk.sysvars.clock.unix_timestamp = NOW;
        let logger = Rc::new(RefCell::new(LogCollector::default()));
        mollusk.logger = Some(logger.clone());
        let result = mollusk.process_transaction_instructions(&instructions, &accounts, None);
        let logs = logger.borrow().get_recorded_content().to_vec();
        Run { result, logs }
    }
}

#[test]
fn a_payout_is_withheld_converted_and_repaid_in_one_go() {
    let setup = Setup::payout();
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    let reward = run.token(&setup.reward_account);
    assert_eq!(reward.amount, HELD + PAYOUT - HALF);
    assert_eq!(reward.delegated_amount, ALLOWANCE - HALF);
    assert_eq!(run.token(&setup.conversion_state.reward_vault).amount, HALF);
    assert_eq!(
        run.token(&setup.conversion_state.stable_vault).amount,
        CONVERSION_STABLE - HALF_PAID
    );
    assert_eq!(
        run.token(&setup.vault).amount,
        DEPOSITS - OUTSTANDING + HALF_PAID
    );

    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(loan.outstanding, OUTSTANDING - HALF_PAID);
    assert_eq!(loan.status, LoanStatus::Active);
    let operator: OperatorAccount = run.state(&setup.operator_account());
    assert_eq!(operator.total_debt, OUTSTANDING - HALF_PAID);
    assert_eq!(operator.open_loans, 1);
    let pool: Pool = run.state(&setup.pool);
    assert_eq!(pool.total_borrowed, OUTSTANDING - HALF_PAID);
    assert_eq!(pool.total_deposits, DEPOSITS);
    let watch: RewardWatch = run.state(&setup.watch());
    assert_eq!(watch.balance, HELD + PAYOUT - HALF);

    let swept = run.events::<Swept>();
    assert_eq!(swept.len(), 1);
    let event = &swept[0];
    assert_eq!(
        (
            event.loan,
            event.operator,
            event.reward_mint,
            event.withheld,
            event.paid,
            event.stable_per_trillion_reward,
            event.deviation_bps,
            event.remaining_debt,
        ),
        (
            setup.address(0),
            setup.operator,
            setup.reward_mint,
            HALF,
            HALF_PAID,
            RATE,
            30,
            OUTSTANDING - HALF_PAID,
        )
    );
    assert!(run.events::<SweepSkipped>().is_empty());
}

#[test]
fn a_debt_smaller_than_the_share_is_paid_exactly_and_the_loan_closes() {
    let mut setup = Setup::payout();
    setup.loans = vec![setup.loan(1, 1_000_000, 5_000)];
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    // The fewest units the vault pays $1 for: 32 355 130 of the 500 000 000 share.
    let reward = run.token(&setup.reward_account);
    assert_eq!(reward.amount, HELD + PAYOUT - 32_355_130);
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(
        (loan.outstanding, loan.accrued_interest, loan.status),
        (0, 0, LoanStatus::Repaid)
    );
    let operator: OperatorAccount = run.state(&setup.operator_account());
    assert_eq!((operator.total_debt, operator.open_loans), (0, 0));
    assert_eq!(
        run.token(&setup.vault).amount,
        DEPOSITS - 1_000_000 + 1_000_000
    );
    let event = &run.events::<Swept>()[0];
    assert_eq!(
        (event.withheld, event.paid, event.remaining_debt),
        (32_355_130, 1_000_000, 0)
    );
}

#[test]
fn interest_accrued_since_the_loan_was_last_touched_is_settled_first() {
    let mut setup = Setup::payout();
    setup.loans[0].last_accrual_at = NOW - 30 * 86_400;
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    // 821 917 of interest over 30 days at 10 %, then 14 631 583 of principal.
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!((loan.accrued_interest, loan.outstanding), (0, 85_368_417));
    let pool: Pool = run.state(&setup.pool);
    assert_eq!(pool.total_deposits, DEPOSITS + 821_917);
    assert_eq!(pool.accrued_interest, 0);
    let operator: OperatorAccount = run.state(&setup.operator_account());
    assert_eq!(operator.total_debt, 85_368_417);
}

#[test]
fn outside_the_tolerance_nothing_moves_and_the_reason_is_on_chain() {
    let mut setup = Setup::payout();
    setup.conversion_state.spread_bps = 200;
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    let reward = run.token(&setup.reward_account);
    assert_eq!(
        (reward.amount, reward.delegated_amount),
        (HELD + PAYOUT, ALLOWANCE)
    );
    assert_eq!(run.token(&setup.conversion_state.reward_vault).amount, 0);
    assert_eq!(
        run.token(&setup.conversion_state.stable_vault).amount,
        CONVERSION_STABLE
    );
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(loan.outstanding, OUTSTANDING);
    // The payout stays above the watch, for a sweep once the market is back in range.
    let watch: RewardWatch = run.state(&setup.watch());
    assert_eq!(watch.balance, HELD);

    assert!(run.events::<Swept>().is_empty());
    let skipped = run.events::<SweepSkipped>();
    assert_eq!(skipped.len(), 1);
    let event = &skipped[0];
    assert_eq!(
        (
            event.operator,
            event.reward_mint,
            event.withheld,
            event.stable_per_trillion_reward,
            event.deviation_bps,
            event.max_slippage_bps,
        ),
        (
            setup.operator,
            setup.reward_mint,
            HALF,
            RATE,
            200,
            TOLERANCE
        )
    );
}

#[test]
fn a_second_sweep_of_the_same_payout_withholds_nothing() {
    let mut setup = Setup::payout();
    setup.sweeps = 2;
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    assert_eq!(
        run.token(&setup.reward_account).amount,
        HELD + PAYOUT - HALF
    );
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(loan.outstanding, OUTSTANDING - HALF_PAID);
    assert_eq!(run.events::<Swept>().len(), 1);
}

#[test]
fn without_a_new_payout_nothing_is_withheld() {
    let mut setup = Setup::payout();
    setup.watch_balance = HELD + PAYOUT;
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    assert_eq!(run.token(&setup.reward_account).amount, HELD + PAYOUT);
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(loan.outstanding, OUTSTANDING);
    assert!(run.events::<Swept>().is_empty());
    assert!(run.events::<SweepSkipped>().is_empty());
}

#[test]
fn tokens_moved_out_lower_the_watch_and_nothing_is_withheld() {
    let mut setup = Setup::payout();
    setup.reward_balance = HELD - 100;
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    assert_eq!(run.token(&setup.reward_account).amount, HELD - 100);
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(loan.outstanding, OUTSTANDING);
    // Otherwise the next payout would first have to refill what was moved out.
    let watch: RewardWatch = run.state(&setup.watch());
    assert_eq!(watch.balance, HELD - 100);
}

#[test]
fn each_open_loan_of_the_token_takes_its_share_oldest_first() {
    let mut setup = Setup::payout();
    let mut other = setup.loan(3, OUTSTANDING, 5_000);
    other.reward_mint = Pubkey::new_unique();
    setup.loans = vec![
        setup.loan(2, OUTSTANDING, 3_000),
        setup.loan(1, OUTSTANDING, 6_000),
        other,
    ];
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    let newer: Loan = run.state(&setup.address(0));
    let older: Loan = run.state(&setup.address(1));
    let untouched: Loan = run.state(&setup.address(2));
    assert_eq!(older.outstanding, OUTSTANDING - 18_544_200);
    assert_eq!(newer.outstanding, OUTSTANDING - 9_272_100);
    assert_eq!(untouched.outstanding, OUTSTANDING);
    assert_eq!(
        run.token(&setup.reward_account).amount,
        HELD + PAYOUT - 900_000_000
    );
    let swept = run.events::<Swept>();
    assert_eq!(
        swept
            .iter()
            .map(|event| (event.loan, event.withheld, event.paid))
            .collect::<Vec<_>>(),
        [
            (setup.address(1), 600_000_000, 18_544_200),
            (setup.address(0), 300_000_000, 9_272_100),
        ]
    );
    let operator: OperatorAccount = run.state(&setup.operator_account());
    assert_eq!(
        operator.total_debt,
        3 * OUTSTANDING - 18_544_200 - 9_272_100
    );
}

#[test]
fn nothing_is_withheld_past_the_allowance() {
    let mut setup = Setup::payout();
    setup.delegate = Some((setup.operator_account(), 200_000_000));
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    let reward = run.token(&setup.reward_account);
    assert_eq!(
        (reward.amount, reward.delegated_amount),
        (HELD + PAYOUT - 200_000_000, 0)
    );
    let loan: Loan = run.state(&setup.address(0));
    assert_eq!(loan.outstanding, OUTSTANDING - 6_181_400);
}

#[test]
fn without_our_delegation_nothing_is_withheld() {
    for delegate in [None, Some((Pubkey::new_unique(), ALLOWANCE))] {
        let mut setup = Setup::payout();
        setup.delegate = delegate;
        let run = setup.run();
        assert_eq!(run.outcome(), Ok(()));

        assert_eq!(run.token(&setup.reward_account).amount, HELD + PAYOUT);
        let loan: Loan = run.state(&setup.address(0));
        assert_eq!(loan.outstanding, OUTSTANDING);
        assert!(run.events::<Swept>().is_empty());
    }
}

#[test]
fn a_payout_too_small_to_buy_a_unit_of_stablecoin_withholds_nothing() {
    let mut setup = Setup::payout();
    // Half of 60 units is worth 0.0093 of a stablecoin unit.
    setup.reward_balance = HELD + 60;
    let run = setup.run();
    assert_eq!(run.outcome(), Ok(()));

    assert_eq!(run.token(&setup.reward_account).amount, HELD + 60);
    assert!(run.events::<Swept>().is_empty());
    assert!(run.events::<SweepSkipped>().is_empty());
}

#[test]
fn every_open_loan_of_the_operator_has_to_be_passed() {
    let mut setup = Setup::payout();
    setup.passed = Some(Vec::new());
    assert_eq!(
        setup.run().outcome(),
        refused(RewardFloatError::OpenLoansMismatch)
    );

    let mut setup = Setup::payout();
    setup.passed = Some(vec![setup.address(0), setup.address(0)]);
    assert_eq!(
        setup.run().outcome(),
        refused(RewardFloatError::OpenLoansMismatch)
    );
}

#[test]
fn without_a_rate_the_sweep_is_refused() {
    let mut setup = Setup::payout();
    setup.rate_check = false;
    assert_eq!(
        setup.run().outcome(),
        Err((
            0,
            InstructionError::Custom(RewardFloatError::AttestationMissing.into())
        ))
    );
}

#[test]
fn a_rate_for_another_token_is_refused() {
    let mut setup = Setup::payout();
    setup.rate_mint = Pubkey::new_unique();
    assert_eq!(
        setup.run().outcome(),
        refused(RewardFloatError::RateAttestationWrongMint)
    );
}

#[test]
fn a_conversion_vault_of_another_pool_is_refused() {
    let mut setup = Setup::payout();
    setup.conversion_state.pool = Pubkey::new_unique();
    assert_eq!(
        setup.run().outcome(),
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintHasOne)
    );
}

#[test]
fn only_the_operator_s_own_reward_account_is_swept() {
    let mut setup = Setup::payout();
    setup.reward_account = Pubkey::new_unique();
    assert_eq!(
        setup.run().outcome(),
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintAddress)
    );
}
