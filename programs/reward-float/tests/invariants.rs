// SC-006 and SC-007 over random sequences of borrows, repayments, deposits and time
// passing, run as real transactions against the built program. An independent model of
// the books predicts the outcome of every step, and after every step the on-chain state
// has to agree with it to the base unit.
mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use common::{m, metas, mint_account, mollusk, token_account, wallet, LAMPORTS_PER_SOL};
use ed25519_dalek::{Signer, SigningKey};
use mollusk_svm::result::types::{TransactionProgramResult, TransactionResult};
use mollusk_svm::MolluskContext;
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use reward_float::error::RewardFloatError;
use reward_float::instructions::verify_attestation::LIMIT_ATTESTATION_TAG;
use reward_float::{
    LenderShare, Loan, OperatorAccount, Pool, LOAN_SEED, MAX_OPEN_LOANS, MAX_TERM_PERIODS,
    OPERATOR_SEED, POOL_SEED, SECONDS_PER_YEAR, SHARE_SEED, VAULT_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::{AccountMeta, Instruction};
use solana_sdk_ids::{ed25519_program, sysvar};

const SEQUENCES: u32 = 1_000;
const START: i64 = 1_790_157_600;
const OPERATORS: usize = 2;
const LENDERS: usize = 2;
const MAX_DEPOSITS: u64 = 1_000_000_000;
const LIMIT_SPAN: u64 = 400_000_000;
const BASE_APR_BPS: u16 = 800;
const SLOPE_APR_BPS: u16 = 2_000;
// Written out here rather than imported, so the model does not share the program's
// arithmetic: interest for `dt` seconds is `outstanding · apr_bps · dt` over this.
const DENOMINATOR: u128 = 10_000 * SECONDS_PER_YEAR as u128;

type Outcome = Result<(), (usize, InstructionError)>;

#[derive(Clone, Copy, Debug)]
enum Limit {
    Above(u64),
    Below(u64),
}

#[derive(Clone, Copy, Debug)]
enum Ask {
    Headroom,
    OverHeadroom,
    ShareOfHeadroom(u16),
    Free,
    OverFree,
    Raw(u64),
}

// Ways to present the open loans so that some of their interest stays out of the limit.
#[derive(Clone, Copy, Debug)]
enum Bypass {
    Hide,
    Duplicate,
    Repaid,
    Foreign,
}

#[derive(Clone, Copy, Debug)]
enum Pay {
    ShareOfDebt(u16),
    Debt,
    OverDebt(u64),
    One,
}

#[derive(Clone, Copy, Debug)]
enum Op {
    Wait(i64),
    Borrow {
        operator: usize,
        limit: Limit,
        ask: Ask,
        term_periods: u8,
        bypass: Option<Bypass>,
    },
    Repay {
        operator: usize,
        loan: usize,
        pay: Pay,
    },
    Deposit {
        lender: usize,
        amount: u64,
    },
}

fn op() -> impl Strategy<Value = Op> {
    let wait = prop_oneof![1i64..=600, 600i64..=86_400, 86_400i64..=90 * 86_400].prop_map(Op::Wait);
    let limit = prop_oneof![
        3 => (0..=LIMIT_SPAN).prop_map(Limit::Above),
        1 => (1..=LIMIT_SPAN).prop_map(Limit::Below),
    ];
    // Mostly asks the limit allows, so that an operator often gets to MAX_OPEN_LOANS.
    let ask = prop_oneof![
        2 => Just(Ask::Headroom),
        1 => Just(Ask::OverHeadroom),
        4 => (1u16..=1_000).prop_map(Ask::ShareOfHeadroom),
        1 => Just(Ask::Free),
        1 => Just(Ask::OverFree),
        1 => (1..=2 * MAX_DEPOSITS).prop_map(Ask::Raw),
    ];
    let bypass = prop::option::weighted(
        0.15,
        prop_oneof![
            Just(Bypass::Hide),
            Just(Bypass::Duplicate),
            Just(Bypass::Repaid),
            Just(Bypass::Foreign),
        ],
    );
    let borrow = (0..OPERATORS, limit, ask, 1..=MAX_TERM_PERIODS, bypass).prop_map(
        |(operator, limit, ask, term_periods, bypass)| Op::Borrow {
            operator,
            limit,
            ask,
            term_periods,
            bypass,
        },
    );
    let pay = prop_oneof![
        (1u16..=1_000).prop_map(Pay::ShareOfDebt),
        Just(Pay::Debt),
        (1..=MAX_DEPOSITS).prop_map(Pay::OverDebt),
        Just(Pay::One),
    ];
    let repay = (0..OPERATORS, 0..16usize, pay).prop_map(|(operator, loan, pay)| Op::Repay {
        operator,
        loan,
        pay,
    });
    let amount = prop_oneof![Just(1u64), 1..=MAX_DEPOSITS];
    let deposit = (0..LENDERS, amount).prop_map(|(lender, amount)| Op::Deposit { lender, amount });
    prop_oneof![4 => borrow, 3 => repay, 2 => wait, 1 => deposit]
}

fn share(of: u64, permille: u16) -> u64 {
    (u128::from(of) * u128::from(permille) / 1_000) as u64
}

// Witnesses that the sequences reach every case the invariants are about. A run in which
// none of them is ever hit would pass on any program.
struct Coverage {
    lent: AtomicU32,
    lent_up_to_the_limit: AtomicU32,
    lent_all_free_liquidity: AtomicU32,
    refused_over_the_limit: AtomicU32,
    refused_over_the_liquidity: AtomicU32,
    refused_a_bypass: AtomicU32,
    refused_too_many_loans: AtomicU32,
    refused_a_repaid_loan: AtomicU32,
    repaid_interest: AtomicU32,
    repaid_in_full: AtomicU32,
    outgrown_by_interest: AtomicU32,
    deposited: AtomicU32,
    deposited_above_par: AtomicU32,
    refused_a_deposit_under_a_share: AtomicU32,
}

static COVERAGE: Coverage = Coverage {
    lent: AtomicU32::new(0),
    lent_up_to_the_limit: AtomicU32::new(0),
    lent_all_free_liquidity: AtomicU32::new(0),
    refused_over_the_limit: AtomicU32::new(0),
    refused_over_the_liquidity: AtomicU32::new(0),
    refused_a_bypass: AtomicU32::new(0),
    refused_too_many_loans: AtomicU32::new(0),
    refused_a_repaid_loan: AtomicU32::new(0),
    repaid_interest: AtomicU32::new(0),
    repaid_in_full: AtomicU32::new(0),
    outgrown_by_interest: AtomicU32::new(0),
    deposited: AtomicU32::new(0),
    deposited_above_par: AtomicU32::new(0),
    refused_a_deposit_under_a_share: AtomicU32::new(0),
};

fn hit(counter: &AtomicU32) {
    counter.fetch_add(1, Ordering::Relaxed);
}

struct ModelLoan {
    address: Pubkey,
    operator: usize,
    apr_bps: u16,
    principal: u64,
    // Interest owed, as a numerator over DENOMINATOR, fraction included.
    interest: u128,
    open: bool,
}

impl ModelLoan {
    fn interest_units(&self) -> u64 {
        (self.interest / DENOMINATOR) as u64
    }

    fn debt(&self) -> u64 {
        self.principal + self.interest_units()
    }
}

struct Operator {
    key: Pubkey,
    account: Pubkey,
    destination: Pubkey,
    next_nonce: u64,
    last_limit: Option<u64>,
}

struct Lender {
    key: Pubkey,
    source: Pubkey,
    share: Pubkey,
    shares: u64,
}

struct World {
    context: MolluskContext<HashMap<solana_pubkey::Pubkey, Account>>,
    now: i64,
    attestor: SigningKey,
    reward_mint: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    payer: Pubkey,
    source: Pubkey,
    operators: Vec<Operator>,
    lenders: Vec<Lender>,
    deposits: u64,
    shares: u64,
    borrowed: u64,
    loans: Vec<ModelLoan>,
}

fn program_account(state: &impl AccountSerialize) -> Account {
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    Account {
        lamports: LAMPORTS_PER_SOL,
        data,
        owner: m(&reward_float::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn outcome(result: &TransactionResult) -> Outcome {
    match &result.program_result {
        TransactionProgramResult::Success => Ok(()),
        TransactionProgramResult::Failure(at, err) => {
            Err((*at, InstructionError::from(u64::from(err.clone()))))
        }
        TransactionProgramResult::UnknownError(at, err) => Err((*at, err.clone())),
    }
}

fn code(err: RewardFloatError) -> u32 {
    err.into()
}

fn refused(at: usize, err: RewardFloatError) -> Outcome {
    Err((at, InstructionError::Custom(err.into())))
}

impl World {
    fn new(deposits: u64) -> Self {
        let attestor = SigningKey::from_bytes(&[1; 32]);
        let stable_mint = Pubkey::new_unique();
        let reward_mint = Pubkey::new_unique();
        let (pool, pool_bump) =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID);
        let vault = Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0;
        let payer = Pubkey::new_unique();
        let source = Pubkey::new_unique();

        let mut store = HashMap::new();
        let pool_state = Pool {
            authority: Pubkey::new_unique(),
            attestor: Pubkey::new_from_array(attestor.verifying_key().to_bytes()),
            stable_mint,
            vault,
            total_shares: deposits,
            total_deposits: deposits,
            total_borrowed: 0,
            accrued_interest: 0,
            accrual_rate: 0,
            accrual_rate_time: 0,
            accrual_remainders: 0,
            overdue_principal: 0,
            base_apr_bps: BASE_APR_BPS,
            slope_apr_bps: SLOPE_APR_BPS,
            bump: pool_bump,
        };
        store.insert(m(&pool), program_account(&pool_state));
        store.insert(m(&vault), token_account(&stable_mint, &pool, deposits));
        store.insert(m(&reward_mint), mint_account());
        store.insert(m(&payer), wallet());
        store.insert(
            m(&source),
            token_account(&stable_mint, &payer, u64::MAX / 2),
        );

        let operators = (0..OPERATORS)
            .map(|_| {
                let key = Pubkey::new_unique();
                let destination = Pubkey::new_unique();
                store.insert(m(&key), wallet());
                store.insert(m(&destination), token_account(&stable_mint, &key, 0));
                Operator {
                    key,
                    account: Pubkey::find_program_address(
                        &[OPERATOR_SEED, key.as_ref()],
                        &reward_float::ID,
                    )
                    .0,
                    destination,
                    next_nonce: 0,
                    last_limit: None,
                }
            })
            .collect();

        let lenders = (0..LENDERS)
            .map(|_| {
                let key = Pubkey::new_unique();
                let source = Pubkey::new_unique();
                store.insert(m(&key), wallet());
                store.insert(m(&source), token_account(&stable_mint, &key, u64::MAX / 4));
                Lender {
                    key,
                    source,
                    share: Pubkey::find_program_address(
                        &[SHARE_SEED, pool.as_ref(), key.as_ref()],
                        &reward_float::ID,
                    )
                    .0,
                    shares: 0,
                }
            })
            .collect();

        Self {
            context: mollusk().with_context(store),
            now: START,
            attestor,
            reward_mint,
            pool,
            vault,
            payer,
            source,
            operators,
            lenders,
            deposits,
            shares: deposits,
            borrowed: 0,
            loans: Vec::new(),
        }
    }

    fn stored(&self, key: &Pubkey) -> Option<Account> {
        self.context
            .account_store
            .borrow()
            .get(&m(key))
            .filter(|account| account.lamports > 0)
            .cloned()
    }

    fn read<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let account = self.stored(key).unwrap();
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn token_balance(&self, key: &Pubkey) -> u64 {
        spl_token::state::Account::unpack(&self.stored(key).unwrap().data)
            .unwrap()
            .amount
    }

    fn debt_of(&self, operator: usize) -> u64 {
        self.loans
            .iter()
            .filter(|loan| loan.open && loan.operator == operator)
            .map(ModelLoan::debt)
            .sum()
    }

    fn run(&mut self, instructions: &[Instruction]) -> Outcome {
        self.context.mollusk.sysvars.clock.unix_timestamp = self.now;
        outcome(
            &self
                .context
                .process_transaction_instructions(instructions, None),
        )
    }

    fn step(&mut self, op: Op) -> Result<(), TestCaseError> {
        match op {
            Op::Wait(seconds) => self.wait(seconds),
            Op::Borrow {
                operator,
                limit,
                ask,
                term_periods,
                bypass,
            } => self.borrow(operator, limit, ask, term_periods, bypass)?,
            Op::Repay {
                operator,
                loan,
                pay,
            } => self.repay(operator, loan, pay)?,
            Op::Deposit { lender, amount } => self.deposit(lender, amount)?,
        }
        self.check_books()
    }

    fn wait(&mut self, seconds: i64) {
        self.now += seconds;
        for loan in self.loans.iter_mut().filter(|loan| loan.open) {
            loan.interest += u128::from(loan.principal)
                * u128::from(loan.apr_bps)
                * u128::try_from(seconds).unwrap();
        }
        for operator in 0..OPERATORS {
            if let Some(limit) = self.operators[operator].last_limit {
                if self.debt_of(operator) > limit {
                    hit(&COVERAGE.outgrown_by_interest);
                }
            }
        }
    }

    fn borrow(
        &mut self,
        operator: usize,
        limit: Limit,
        ask: Ask,
        term_periods: u8,
        bypass: Option<Bypass>,
    ) -> Result<(), TestCaseError> {
        let debt = self.debt_of(operator);
        let limit = match limit {
            Limit::Above(headroom) => debt + headroom,
            Limit::Below(short) => debt.saturating_sub(short),
        };
        let headroom = limit.saturating_sub(debt);
        let free = self.deposits - self.borrowed;
        let amount = match ask {
            Ask::Headroom => headroom,
            Ask::OverHeadroom => headroom + 1,
            Ask::ShareOfHeadroom(permille) => share(headroom, permille),
            Ask::Free => free,
            Ask::OverFree => free + 1,
            Ask::Raw(amount) => amount,
        }
        .max(1);

        let open: Vec<Pubkey> = self
            .loans
            .iter()
            .filter(|loan| loan.open && loan.operator == operator)
            .map(|loan| loan.address)
            .collect();
        let (passed, bypassed) = self.present_open_loans(operator, &open, bypass);

        let expected = if open.len() >= MAX_OPEN_LOANS as usize {
            refused(1, RewardFloatError::TooManyOpenLoans)
        } else if bypassed {
            refused(1, RewardFloatError::OpenLoansMismatch)
        } else if debt + amount > limit {
            refused(1, RewardFloatError::CreditLimitExceeded)
        } else if amount > free {
            refused(1, RewardFloatError::InsufficientLiquidity)
        } else {
            Ok(())
        };

        let nonce = self.operators[operator].next_nonce;
        self.operators[operator].next_nonce += 1;
        let instructions = [
            self.attestation(operator, limit, nonce),
            self.borrow_instruction(operator, nonce, amount, term_periods, &passed),
        ];
        let actual = self.run(&instructions);
        prop_assert_eq!(&actual, &expected);

        match expected {
            Ok(()) => {
                let apr_bps = BASE_APR_BPS as u128
                    + (u128::from(SLOPE_APR_BPS) * u128::from(self.borrowed + amount))
                        .div_ceil(u128::from(self.deposits));
                self.loans.push(ModelLoan {
                    address: self.loan_address(operator, nonce),
                    operator,
                    apr_bps: u16::try_from(apr_bps).unwrap(),
                    principal: amount,
                    interest: 0,
                    open: true,
                });
                self.borrowed += amount;
                self.operators[operator].last_limit = Some(limit);
                // SC-006 and SC-007 as the spec words them.
                prop_assert!(self.debt_of(operator) <= limit);
                prop_assert!(amount <= free);
                hit(&COVERAGE.lent);
                if self.debt_of(operator) == limit {
                    hit(&COVERAGE.lent_up_to_the_limit);
                }
                if amount == free {
                    hit(&COVERAGE.lent_all_free_liquidity);
                }
            }
            Err((_, InstructionError::Custom(refusal))) => {
                let counter = match refusal {
                    c if c == code(RewardFloatError::CreditLimitExceeded) => {
                        &COVERAGE.refused_over_the_limit
                    }
                    c if c == code(RewardFloatError::InsufficientLiquidity) => {
                        &COVERAGE.refused_over_the_liquidity
                    }
                    c if c == code(RewardFloatError::OpenLoansMismatch) => {
                        &COVERAGE.refused_a_bypass
                    }
                    c if c == code(RewardFloatError::TooManyOpenLoans) => {
                        &COVERAGE.refused_too_many_loans
                    }
                    _ => unreachable!(),
                };
                hit(counter);
            }
            Err(_) => unreachable!(),
        }
        Ok(())
    }

    // The open loans as `borrow` gets them in its remaining accounts: all of them, or, for
    // a bypass, a list that leaves some of their interest out. Says whether it does.
    fn present_open_loans(
        &self,
        operator: usize,
        open: &[Pubkey],
        bypass: Option<Bypass>,
    ) -> (Vec<Pubkey>, bool) {
        let Some(bypass) = bypass.filter(|_| !open.is_empty()) else {
            return (open.to_vec(), false);
        };
        let repaid = self
            .loans
            .iter()
            .find(|loan| !loan.open && loan.operator == operator);
        let foreign = self
            .loans
            .iter()
            .find(|loan| loan.open && loan.operator != operator);
        let mut passed = open.to_vec();
        match (bypass, repaid, foreign) {
            (Bypass::Duplicate, _, _) if open.len() == 1 => passed.push(open[0]),
            (Bypass::Duplicate, _, _) => passed[open.len() - 1] = open[0],
            (Bypass::Repaid, Some(loan), _) | (Bypass::Foreign, _, Some(loan)) => {
                passed[0] = loan.address
            }
            _ => {
                passed.pop();
            }
        }
        (passed, true)
    }

    fn repay(&mut self, operator: usize, pick: usize, pay: Pay) -> Result<(), TestCaseError> {
        let owned: Vec<usize> = (0..self.loans.len())
            .filter(|&index| self.loans[index].operator == operator)
            .collect();
        if owned.is_empty() {
            return Ok(());
        }
        let index = owned[pick % owned.len()];
        let loan = &self.loans[index];
        let debt = if loan.open { loan.debt() } else { 0 };
        let max_amount = match pay {
            Pay::ShareOfDebt(permille) => share(debt, permille),
            Pay::Debt => debt,
            Pay::OverDebt(extra) => debt + extra,
            Pay::One => 1,
        }
        .max(1);
        let expected = if loan.open {
            Ok(())
        } else {
            refused(0, RewardFloatError::LoanNotOpen)
        };

        let before = self.token_balance(&self.source);
        let instruction = self.repay_instruction(&loan.address, max_amount);
        let actual = self.run(&[instruction]);
        prop_assert_eq!(&actual, &expected);
        if expected.is_err() {
            hit(&COVERAGE.refused_a_repaid_loan);
            return Ok(());
        }

        let loan = &mut self.loans[index];
        let paid = max_amount.min(debt);
        let interest = paid.min(loan.interest_units());
        let principal = paid - interest;
        loan.interest -= u128::from(interest) * DENOMINATOR;
        loan.principal -= principal;
        if loan.principal == 0 && loan.interest_units() == 0 {
            loan.open = false;
            hit(&COVERAGE.repaid_in_full);
        }
        if interest > 0 {
            hit(&COVERAGE.repaid_interest);
        }
        self.borrowed -= principal;
        self.deposits += interest;
        // FR-011: the excess over the debt is not taken.
        prop_assert_eq!(before - self.token_balance(&self.source), paid);
        Ok(())
    }

    // What the pool is worth if every open loan were brought up to this second.
    fn value(&self) -> u128 {
        let interest: u128 = self
            .loans
            .iter()
            .filter(|loan| loan.open)
            .map(|loan| loan.interest)
            .sum();
        u128::from(self.deposits) + interest / DENOMINATOR
    }

    fn deposit(&mut self, lender: usize, amount: u64) -> Result<(), TestCaseError> {
        let value = self.value();
        let shares = (u128::from(amount) * u128::from(self.shares) / value) as u64;
        let expected = if shares == 0 {
            refused(0, RewardFloatError::DepositTooSmall)
        } else {
            Ok(())
        };

        let instruction = self.deposit_instruction(lender, amount);
        let actual = self.run(&[instruction]);
        prop_assert_eq!(&actual, &expected);
        if expected.is_err() {
            hit(&COVERAGE.refused_a_deposit_under_a_share);
            return Ok(());
        }

        // FR-018: whoever was in before does not lose a unit of value per share to it.
        prop_assert!(
            (value + u128::from(amount)) * u128::from(self.shares)
                >= value * u128::from(self.shares + shares)
        );
        self.deposits += amount;
        self.shares += shares;
        self.lenders[lender].shares += shares;
        hit(&COVERAGE.deposited);
        if shares < amount {
            hit(&COVERAGE.deposited_above_par);
        }
        Ok(())
    }

    // Every book the limit check and the liquidity check read, against the model. The
    // limit is checked against `OperatorAccount.total_debt`, so a book that drifts from
    // the loans would make the check compare against the wrong number.
    fn check_books(&self) -> Result<(), TestCaseError> {
        let pool: Pool = self.read(&self.pool);
        prop_assert_eq!(pool.total_deposits, self.deposits);
        prop_assert_eq!(pool.total_borrowed, self.borrowed);
        prop_assert!(pool.total_borrowed <= pool.total_deposits);
        prop_assert_eq!(
            self.token_balance(&self.vault),
            pool.total_deposits - pool.total_borrowed
        );

        let mut booked_debt = [0u64; OPERATORS];
        let mut open_loans = [0u32; OPERATORS];
        let mut booked_interest = 0u64;
        let mut rate = 0u128;
        let mut earned = 0u128;
        for loan in &self.loans {
            let state: Loan = self.read(&loan.address);
            prop_assert_eq!(state.outstanding, loan.principal);
            prop_assert_eq!(state.apr_bps, loan.apr_bps);
            prop_assert_eq!(state.is_open(), loan.open);
            let since = u128::try_from(self.now - state.last_accrual_at).unwrap();
            prop_assert_eq!(
                u128::from(state.accrued_interest) * DENOMINATOR
                    + u128::from(state.interest_remainder)
                    + u128::from(state.outstanding) * u128::from(state.apr_bps) * since,
                loan.interest
            );
            if loan.open {
                booked_debt[loan.operator] += state.outstanding + state.accrued_interest;
                open_loans[loan.operator] += 1;
                booked_interest += state.accrued_interest;
                rate += u128::from(loan.principal) * u128::from(loan.apr_bps);
                earned += loan.interest;
            }
        }
        prop_assert_eq!(pool.accrued_interest, booked_interest);
        // The accrual sums say how much was earned and not booked, exactly as the loans do.
        prop_assert_eq!(pool.accrual_rate, rate);
        prop_assert_eq!(
            pool.accrual_rate * u128::try_from(self.now).unwrap() + pool.accrual_remainders
                - pool.accrual_rate_time,
            earned - u128::from(pool.accrued_interest) * DENOMINATOR
        );

        prop_assert_eq!(pool.total_shares, self.shares);
        for lender in &self.lenders {
            match self.stored(&lender.share) {
                None => prop_assert_eq!(lender.shares, 0),
                Some(_) => {
                    let state: LenderShare = self.read(&lender.share);
                    prop_assert_eq!(state.shares, lender.shares);
                    prop_assert_eq!(state.owner, lender.key);
                }
            }
        }

        for (index, operator) in self.operators.iter().enumerate() {
            if self.stored(&operator.account).is_none() {
                prop_assert_eq!(open_loans[index], 0);
                continue;
            }
            let state: OperatorAccount = self.read(&operator.account);
            prop_assert_eq!(state.total_debt, booked_debt[index]);
            prop_assert_eq!(state.open_loans, open_loans[index]);
        }
        Ok(())
    }

    fn loan_address(&self, operator: usize, nonce: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[
                LOAN_SEED,
                self.operators[operator].key.as_ref(),
                &nonce.to_le_bytes(),
            ],
            &reward_float::ID,
        )
        .0
    }

    // The layout of solana's `new_ed25519_instruction`, every offset pointing into the
    // instruction itself.
    fn attestation(&self, operator: usize, limit: u64, nonce: u64) -> Instruction {
        let mut message = LIMIT_ATTESTATION_TAG.to_vec();
        message.extend_from_slice(self.operators[operator].key.as_ref());
        message.extend_from_slice(&limit.to_le_bytes());
        message.extend_from_slice(&(self.now - 60).to_le_bytes());
        message.extend_from_slice(&(self.now + 300).to_le_bytes());
        message.extend_from_slice(&nonce.to_le_bytes());
        let signature = self.attestor.sign(&message).to_bytes();
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
        data.extend_from_slice(self.attestor.verifying_key().as_bytes());
        data.extend_from_slice(&signature);
        data.extend_from_slice(&message);
        Instruction {
            program_id: m(&ed25519_program::ID),
            accounts: vec![],
            data,
        }
    }

    fn borrow_instruction(
        &self,
        operator: usize,
        nonce: u64,
        amount: u64,
        term_periods: u8,
        open_loans: &[Pubkey],
    ) -> Instruction {
        let who = &self.operators[operator];
        let mut accounts = metas(
            reward_float::accounts::Borrow {
                operator: who.key,
                pool: self.pool,
                operator_account: who.account,
                loan: self.loan_address(operator, nonce),
                vault: self.vault,
                destination: who.destination,
                reward_mint: self.reward_mint,
                instructions: sysvar::instructions::ID,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        accounts.extend(open_loans.iter().map(|address| AccountMeta {
            pubkey: m(address),
            is_signer: false,
            is_writable: true,
        }));
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::Borrow {
                nonce,
                amount,
                term_periods,
                sweep_bps: 5_000,
                max_apr_bps: u16::MAX,
            }
            .data(),
        }
    }

    fn deposit_instruction(&self, lender: usize, amount: u64) -> Instruction {
        let who = &self.lenders[lender];
        Instruction {
            program_id: m(&reward_float::ID),
            accounts: metas(
                reward_float::accounts::Deposit {
                    lender: who.key,
                    pool: self.pool,
                    lender_share: who.share,
                    vault: self.vault,
                    source: who.source,
                    token_program: spl_token::ID,
                    system_program: anchor_lang::system_program::ID,
                }
                .to_account_metas(None),
            ),
            data: reward_float::instruction::Deposit { amount }.data(),
        }
    }

    fn repay_instruction(&self, loan: &Pubkey, max_amount: u64) -> Instruction {
        let operator = self.read::<Loan>(loan).operator;
        Instruction {
            program_id: m(&reward_float::ID),
            accounts: metas(
                reward_float::accounts::Repay {
                    payer: self.payer,
                    pool: self.pool,
                    loan: *loan,
                    operator_account: Pubkey::find_program_address(
                        &[OPERATOR_SEED, operator.as_ref()],
                        &reward_float::ID,
                    )
                    .0,
                    vault: self.vault,
                    source: self.source,
                    token_program: spl_token::ID,
                }
                .to_account_metas(None),
            ),
            data: reward_float::instruction::Repay { max_amount }.data(),
        }
    }
}

fn run_sequence(deposits: u64, ops: &[Op]) -> Result<(), TestCaseError> {
    let mut world = World::new(deposits);
    for &op in ops {
        world.step(op)?;
    }
    Ok(())
}

#[test]
fn no_sequence_lends_past_the_limit_or_past_the_free_liquidity_or_dilutes_a_share() {
    let mut runner = TestRunner::new(Config {
        cases: SEQUENCES,
        failure_persistence: None,
        ..Config::default()
    });
    let sequences = (10_000_000..=MAX_DEPOSITS, vec(op(), 1..=40));
    if let Err(failure) = runner.run(&sequences, |(deposits, ops)| run_sequence(deposits, &ops)) {
        panic!("{failure}");
    }

    let witnessed = [
        ("lent", &COVERAGE.lent),
        ("lent up to the limit", &COVERAGE.lent_up_to_the_limit),
        ("lent all free liquidity", &COVERAGE.lent_all_free_liquidity),
        ("refused over the limit", &COVERAGE.refused_over_the_limit),
        (
            "refused over the liquidity",
            &COVERAGE.refused_over_the_liquidity,
        ),
        ("refused a bypass", &COVERAGE.refused_a_bypass),
        ("refused too many loans", &COVERAGE.refused_too_many_loans),
        ("refused a repaid loan", &COVERAGE.refused_a_repaid_loan),
        ("repaid interest", &COVERAGE.repaid_interest),
        ("repaid in full", &COVERAGE.repaid_in_full),
        ("outgrown by interest", &COVERAGE.outgrown_by_interest),
        ("deposited", &COVERAGE.deposited),
        ("deposited above par", &COVERAGE.deposited_above_par),
        (
            "refused a deposit under a share",
            &COVERAGE.refused_a_deposit_under_a_share,
        ),
    ];
    for (name, counter) in witnessed {
        let count = counter.load(Ordering::Relaxed);
        println!("{name}: {count}");
        assert!(count > 0, "no sequence {name}");
    }
}
