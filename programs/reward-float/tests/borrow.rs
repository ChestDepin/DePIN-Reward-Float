mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::spl_token;
use common::{m, metas, mint_account, mollusk, token_account, track, wallet, LAMPORTS_PER_SOL};
use ed25519_dalek::{Signer, SigningKey};
use mollusk_svm::result::types::{TransactionProgramResult, TransactionResult};
use reward_float::error::RewardFloatError;
use reward_float::instructions::verify_attestation::{LIMIT_ATTESTATION_TAG, RATE_ATTESTATION_TAG};
use reward_float::{
    Loan, LoanStatus, OperatorAccount, Pool, RewardWatch, LOAN_SEED, MAX_OPEN_LOANS,
    NONCE_WINDOW_WORDS, OPERATOR_SEED, POOL_SEED, REPAYMENT_PERIOD, SECONDS_PER_YEAR, VAULT_SEED,
    WATCH_SEED,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::{AccountMeta, Instruction};
use solana_sdk_ids::{ed25519_program, sysvar};

const NOW: i64 = 1_790_157_600;
const DEPOSITS: u64 = 1_000_000_000;
const LIMIT: u64 = 150_000_000;
const AMOUNT: u64 = 100_000_000;
// 800 base + 2000 × 10 % utilisation once AMOUNT is out.
const APR: u16 = 1_000;
// Stablecoin base units for 10^12 reward base units: 1000 HONEY for 2.406662 USDC.
const RATE: u64 = 2_406_662;
// AMOUNT plus 1 000 bps on it over three periods, 102 465 753, at RATE; worked out in
// Python, not by the code under test.
const FIRST_ALLOWANCE: u64 = 42_575_880_202_537;

// Position of borrow in the transaction, after the rate's and then the limit's ed25519
// checks.
const BORROW: usize = 2;

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
    Err((BORROW, InstructionError::Custom(err.into())))
}

fn refused_by_anchor(code: anchor_lang::error::ErrorCode) -> Outcome {
    Err((BORROW, InstructionError::Custom(code.into())))
}

fn attestor_key(signer: &SigningKey) -> Pubkey {
    Pubkey::new_from_array(signer.verifying_key().to_bytes())
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

fn account<'a>(result: &'a TransactionResult, key: &Pubkey) -> &'a Account {
    result.get_account(&m(key)).unwrap()
}

fn deserialize<T: AccountDeserialize>(result: &TransactionResult, key: &Pubkey) -> T {
    T::try_deserialize(&mut account(result, key).data.as_slice()).unwrap()
}

fn token_balance(result: &TransactionResult, key: &Pubkey) -> u64 {
    spl_token::state::Account::unpack(&account(result, key).data)
        .unwrap()
        .amount
}

// The layout of solana's `new_ed25519_instruction`, every offset pointing into the
// instruction itself.
fn ed25519_instruction(signer: &SigningKey, message: &[u8], forged: bool) -> Instruction {
    let mut signature = signer.sign(message).to_bytes();
    if forged {
        signature[0] ^= 1;
    }
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

struct Rate {
    signer: SigningKey,
    mint: Pubkey,
    rate: u64,
    priced_at: i64,
    expires_at: i64,
}

impl Rate {
    fn message(&self) -> Vec<u8> {
        let mut message = RATE_ATTESTATION_TAG.to_vec();
        message.extend_from_slice(self.mint.as_ref());
        message.extend_from_slice(&self.rate.to_le_bytes());
        message.extend_from_slice(&self.priced_at.to_le_bytes());
        message.extend_from_slice(&self.expires_at.to_le_bytes());
        message
    }
}

fn reward_token_account(mint: &Pubkey, owner: &Pubkey, delegate: Option<(Pubkey, u64)>) -> Account {
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(
        spl_token::state::Account {
            mint: *mint,
            owner: *owner,
            amount: 0,
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

struct Attestation {
    signer: SigningKey,
    operator: Pubkey,
    limit: u64,
    computed_at: i64,
    expires_at: i64,
    nonce: u64,
}

impl Attestation {
    fn message(&self) -> Vec<u8> {
        let mut message = LIMIT_ATTESTATION_TAG.to_vec();
        message.extend_from_slice(self.operator.as_ref());
        message.extend_from_slice(&self.limit.to_le_bytes());
        message.extend_from_slice(&self.computed_at.to_le_bytes());
        message.extend_from_slice(&self.expires_at.to_le_bytes());
        message.extend_from_slice(&self.nonce.to_le_bytes());
        message
    }
}

fn fresh_operator_account(owner: Pubkey) -> OperatorAccount {
    OperatorAccount {
        owner,
        total_debt: 0,
        open_loans: 0,
        overdue: false,
        nonce_floor: 0,
        used_nonces: [0; NONCE_WINDOW_WORDS],
        bump: Pubkey::find_program_address(&[OPERATOR_SEED, owner.as_ref()], &reward_float::ID).1,
    }
}

struct Setup {
    signer: Pubkey,
    stable_mint: Pubkey,
    reward_mint: Pubkey,
    pool: Pubkey,
    pool_state: Pool,
    vault: Pubkey,
    vault_balance: u64,
    destination: Pubkey,
    destination_mint: Pubkey,
    operator_state: Option<OperatorAccount>,
    loan_account: Account,
    // Passed after the named accounts, as `borrow` expects every open loan to be.
    open_loans: Vec<(Pubkey, Account, bool)>,
    attestation: Attestation,
    rate: Rate,
    limit_check: bool,
    rate_check: bool,
    reward_account: Pubkey,
    reward_account_state: Account,
    watch_state: Option<RewardWatch>,
    forged: bool,
    now: i64,
    nonce: u64,
    amount: u64,
    term_periods: u8,
    sweep_bps: u16,
    max_apr_bps: u16,
}

impl Setup {
    fn first_loan() -> Self {
        let operator = Pubkey::new_unique();
        let attestor = SigningKey::from_bytes(&[1; 32]);
        let stable_mint = Pubkey::new_unique();
        let (pool, pool_bump) =
            Pubkey::find_program_address(&[POOL_SEED, stable_mint.as_ref()], &reward_float::ID);
        let vault = Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], &reward_float::ID).0;
        let reward_mint = Pubkey::new_unique();
        Self {
            signer: operator,
            stable_mint,
            reward_mint,
            pool,
            pool_state: Pool {
                authority: Pubkey::new_unique(),
                attestor: attestor_key(&attestor),
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
            vault_balance: DEPOSITS,
            destination: Pubkey::new_unique(),
            destination_mint: stable_mint,
            operator_state: None,
            loan_account: Account::default(),
            open_loans: Vec::new(),
            attestation: Attestation {
                signer: attestor.clone(),
                operator,
                limit: LIMIT,
                computed_at: NOW - 60,
                expires_at: NOW + 300,
                nonce: 7,
            },
            rate: Rate {
                signer: attestor.clone(),
                mint: reward_mint,
                rate: RATE,
                priced_at: NOW - 30,
                expires_at: NOW + 90,
            },
            limit_check: true,
            rate_check: true,
            reward_account: get_associated_token_address(&operator, &reward_mint),
            reward_account_state: reward_token_account(&reward_mint, &operator, None),
            watch_state: None,
            forged: false,
            now: NOW,
            nonce: 7,
            amount: AMOUNT,
            term_periods: 3,
            sweep_bps: 5_000,
            max_apr_bps: APR,
        }
    }

    fn operator_account(&self) -> Pubkey {
        Pubkey::find_program_address(&[OPERATOR_SEED, self.signer.as_ref()], &reward_float::ID).0
    }

    fn watch(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[WATCH_SEED, self.signer.as_ref(), self.reward_mint.as_ref()],
            &reward_float::ID,
        )
    }

    fn loan(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[LOAN_SEED, self.signer.as_ref(), &self.nonce.to_le_bytes()],
            &reward_float::ID,
        )
        .0
    }

    fn loan_at(&self, nonce: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[LOAN_SEED, self.signer.as_ref(), &nonce.to_le_bytes()],
            &reward_float::ID,
        )
    }

    // An open loan of this operator in this pool, with interest up to date at NOW.
    fn existing_loan(&self, nonce: u64, outstanding: u64) -> Loan {
        Loan {
            operator: self.signer,
            pool: self.pool,
            reward_mint: self.reward_mint,
            nonce,
            principal: outstanding,
            outstanding,
            accrued_interest: 0,
            interest_remainder: 0,
            opened_at: NOW - 86_400,
            due_at: NOW - 86_400 + 3 * REPAYMENT_PERIOD,
            last_accrual_at: NOW,
            apr_bps: APR,
            sweep_bps: 5_000,
            status: LoanStatus::Active,
            bump: self.loan_at(nonce).1,
        }
    }

    // A loan of this pool is on its accrual sums too, as `borrow` left it there.
    fn pass_open_loan(&mut self, loan: &Loan) {
        if loan.pool == self.pool && loan.is_open() {
            track(&mut self.pool_state, loan);
        }
        let address = self.loan_at(loan.nonce).0;
        self.open_loans
            .push((address, program_account(serialize(loan)), true));
    }

    fn instruction(&self) -> Instruction {
        let accounts = reward_float::accounts::Borrow {
            operator: self.signer,
            pool: self.pool,
            operator_account: self.operator_account(),
            loan: self.loan(),
            vault: self.vault,
            destination: self.destination,
            reward_mint: self.reward_mint,
            reward_account: self.reward_account,
            reward_watch: self.watch().0,
            instructions: sysvar::instructions::ID,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None);
        let mut accounts = metas(accounts);
        accounts.extend(
            self.open_loans
                .iter()
                .map(|(address, _, writable)| AccountMeta {
                    pubkey: m(address),
                    is_signer: false,
                    is_writable: *writable,
                }),
        );
        Instruction {
            program_id: m(&reward_float::ID),
            accounts,
            data: reward_float::instruction::Borrow {
                nonce: self.nonce,
                amount: self.amount,
                term_periods: self.term_periods,
                sweep_bps: self.sweep_bps,
                max_apr_bps: self.max_apr_bps,
            }
            .data(),
        }
    }

    // The whole transaction, so that the precompile checks the signature and the runtime
    // fills the instructions sysvar and its current index the way it does on chain.
    fn run(&self) -> TransactionResult {
        let mut instructions = Vec::new();
        if self.rate_check {
            instructions.push(ed25519_instruction(
                &self.rate.signer,
                &self.rate.message(),
                false,
            ));
        }
        if self.limit_check {
            instructions.push(ed25519_instruction(
                &self.attestation.signer,
                &self.attestation.message(),
                self.forged,
            ));
        }
        instructions.push(self.instruction());
        let operator_account = match &self.operator_state {
            Some(state) => program_account(serialize(state)),
            None => Account::default(),
        };
        let mut accounts = vec![
            (m(&self.signer), wallet()),
            (m(&self.pool), program_account(serialize(&self.pool_state))),
            (m(&self.operator_account()), operator_account),
            (m(&self.loan()), self.loan_account.clone()),
            (
                m(&self.vault),
                token_account(&self.stable_mint, &self.pool, self.vault_balance),
            ),
            (
                m(&self.destination),
                token_account(&self.destination_mint, &self.signer, 0),
            ),
            (m(&self.reward_mint), mint_account()),
            (m(&self.reward_account), self.reward_account_state.clone()),
            (
                m(&self.watch().0),
                match &self.watch_state {
                    Some(state) => program_account(serialize(state)),
                    None => Account::default(),
                },
            ),
            mollusk_svm_programs_token::token::keyed_account(),
            mollusk_svm::program::keyed_account_for_system_program(),
        ];
        for (address, account, _) in &self.open_loans {
            if !accounts.iter().any(|(key, _)| *key == m(address)) {
                accounts.push((m(address), account.clone()));
            }
        }
        let mut mollusk = mollusk();
        mollusk.sysvars.clock.unix_timestamp = self.now;
        mollusk.process_transaction_instructions(&instructions, &accounts, None)
    }
}

#[test]
fn the_first_loan_opens_the_operator_account_and_fixes_the_terms() {
    let setup = Setup::first_loan();
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    // Measured at 42 792 for the whole transaction: the rate check, the bump search of
    // the reward account's address and the approve call added 17 399 to it. The ceiling
    // leaves room for the bump searches, which cost more or less depending on the keys.
    println!("borrow, first loan: {} CU", result.compute_units_consumed);
    assert!(result.compute_units_consumed <= 60_000);

    let loan: Loan = deserialize(&result, &setup.loan());
    let loan_bump = Pubkey::find_program_address(
        &[LOAN_SEED, setup.signer.as_ref(), &7u64.to_le_bytes()],
        &reward_float::ID,
    )
    .1;
    assert_eq!(
        serialize(&loan),
        serialize(&Loan {
            operator: setup.signer,
            pool: setup.pool,
            reward_mint: setup.reward_mint,
            nonce: 7,
            principal: AMOUNT,
            outstanding: AMOUNT,
            accrued_interest: 0,
            interest_remainder: 0,
            opened_at: NOW,
            due_at: NOW + 3 * REPAYMENT_PERIOD,
            last_accrual_at: NOW,
            apr_bps: APR,
            sweep_bps: 5_000,
            status: LoanStatus::Active,
            bump: loan_bump,
        })
    );

    let mut operator: OperatorAccount = deserialize(&result, &setup.operator_account());
    let mut expected = fresh_operator_account(setup.signer);
    expected.total_debt = AMOUNT;
    expected.open_loans = 1;
    expected.used_nonces[0] = 1 << 7;
    assert_eq!(serialize(&operator), serialize(&expected));
    assert!(operator.consume_nonce(7).is_err(), "the nonce is spent");

    let pool: Pool = deserialize(&result, &setup.pool);
    let mut expected = setup.pool_state.clone();
    expected.total_borrowed = AMOUNT;
    track(&mut expected, &loan);
    assert_eq!(serialize(&pool), serialize(&expected));

    assert_eq!(token_balance(&result, &setup.vault), DEPOSITS - AMOUNT);
    assert_eq!(token_balance(&result, &setup.destination), AMOUNT);
    assert_eq!(
        delegation(&result, &setup.reward_account),
        Some((setup.operator_account(), FIRST_ALLOWANCE))
    );
}

fn with_balance(mut account: Account, amount: u64) -> Account {
    let mut state = spl_token::state::Account::unpack(&account.data).unwrap();
    state.amount = amount;
    spl_token::state::Account::pack(state, &mut account.data).unwrap();
    account
}

fn watched(setup: &Setup, balance: u64) -> RewardWatch {
    RewardWatch {
        operator: setup.signer,
        reward_mint: setup.reward_mint,
        balance,
        bump: setup.watch().1,
    }
}

// Rewards already on the account when the loan goes out are not a payout towards it.
#[test]
fn the_first_loan_on_a_token_starts_the_watch_at_the_balance_already_there() {
    let mut setup = Setup::first_loan();
    setup.reward_account_state = with_balance(setup.reward_account_state.clone(), 7_000);
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let watch: RewardWatch = deserialize(&result, &setup.watch().0);
    assert_eq!(serialize(&watch), serialize(&watched(&setup, 7_000)));
}

// A payout that arrived before this loan and is not swept yet still belongs to the open one.
#[test]
fn a_later_loan_on_the_same_token_leaves_the_watch_where_it_was() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 7;
    setup.operator_state = Some(existing);
    setup.pass_open_loan(&setup.existing_loan(7, AMOUNT));
    setup.pool_state.total_borrowed = AMOUNT;
    setup.vault_balance = DEPOSITS - AMOUNT;
    setup.attestation.nonce = 8;
    setup.nonce = 8;
    setup.amount = LIMIT - AMOUNT;
    setup.max_apr_bps = 1_100;
    setup.reward_account_state = with_balance(setup.reward_account_state.clone(), 5_000);
    setup.watch_state = Some(watched(&setup, 1_000));
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let watch: RewardWatch = deserialize(&result, &setup.watch().0);
    assert_eq!(watch.balance, 1_000);
}

// Loans issued before the program kept a watch have none; the first later loan starts it.
#[test]
fn a_loan_beside_open_ones_from_before_the_watch_starts_it_at_the_balance() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 7;
    setup.operator_state = Some(existing);
    setup.pass_open_loan(&setup.existing_loan(7, AMOUNT));
    setup.pool_state.total_borrowed = AMOUNT;
    setup.vault_balance = DEPOSITS - AMOUNT;
    setup.attestation.nonce = 8;
    setup.nonce = 8;
    setup.amount = LIMIT - AMOUNT;
    setup.max_apr_bps = 1_100;
    setup.reward_account_state = with_balance(setup.reward_account_state.clone(), 5_000);
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let watch: RewardWatch = deserialize(&result, &setup.watch().0);
    assert_eq!(serialize(&watch), serialize(&watched(&setup, 5_000)));
}

// Rewards that came in while nothing was owed on the token are the operator's.
#[test]
fn a_watch_left_by_repaid_loans_restarts_at_the_balance() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.used_nonces[0] = 1 << 6;
    setup.operator_state = Some(existing);
    setup.reward_account_state = with_balance(setup.reward_account_state.clone(), 5_000);
    setup.watch_state = Some(watched(&setup, 1_000));
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let watch: RewardWatch = deserialize(&result, &setup.watch().0);
    assert_eq!(watch.balance, 5_000);
}

fn delegation(result: &TransactionResult, key: &Pubkey) -> Option<(Pubkey, u64)> {
    let state = spl_token::state::Account::unpack(&account(result, key).data).unwrap();
    match state.delegate {
        COption::Some(delegate) => Some((delegate, state.delegated_amount)),
        COption::None => None,
    }
}

#[test]
fn the_allowance_follows_the_rate_the_loan_got_not_the_most_the_operator_agreed_to() {
    // FR-014a: what is owed is at the rate fixed at issue. Sizing the allowance by the
    // ceiling the operator signed would let it outgrow the debt whenever the pool quotes
    // less than that.
    let mut setup = Setup::first_loan();
    setup.max_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    assert_eq!(
        delegation(&result, &setup.reward_account),
        Some((setup.operator_account(), FIRST_ALLOWANCE))
    );
}

#[test]
fn another_protocol_s_delegate_is_replaced_by_ours() {
    // The page asks the operator before this (T045); the program only sees the signature.
    let mut setup = Setup::first_loan();
    setup.reward_account_state = reward_token_account(
        &setup.reward_mint,
        &setup.signer,
        Some((Pubkey::new_unique(), 5)),
    );
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    assert_eq!(
        delegation(&result, &setup.reward_account),
        Some((setup.operator_account(), FIRST_ALLOWANCE))
    );
}

#[test]
fn the_reward_account_has_to_be_the_operator_s_own_for_the_loan_s_token() {
    // An account at the operator's associated address of another mint cannot exist: only
    // the associated token program creates one there, and with that mint.
    let cases: [fn(&mut Setup); 2] = [
        |s| s.reward_account = Pubkey::new_unique(),
        |s| {
            s.reward_account_state =
                reward_token_account(&s.reward_mint, &Pubkey::new_unique(), None)
        },
    ];
    for change in cases {
        let mut setup = Setup::first_loan();
        change(&mut setup);
        let Err((at, _)) = outcome(&setup.run()) else {
            panic!("a loan went out against someone else's rewards");
        };
        assert_eq!(at, BORROW);
    }
}

#[test]
fn without_a_rate_borrow_is_refused() {
    let mut setup = Setup::first_loan();
    setup.rate_check = false;
    let missing: u32 = RewardFloatError::AttestationMissing.into();
    assert_eq!(
        outcome(&setup.run()),
        Err((1, InstructionError::Custom(missing)))
    );
}

#[test]
fn a_rate_signed_by_another_key_is_refused() {
    let mut setup = Setup::first_loan();
    setup.rate.signer = SigningKey::from_bytes(&[2; 32]);
    assert_eq!(
        outcome(&setup.run()),
        refused(RewardFloatError::AttestationWrongSigner)
    );
}

#[test]
fn a_rate_for_another_token_is_refused() {
    let mut setup = Setup::first_loan();
    setup.rate.mint = Pubkey::new_unique();
    assert_eq!(
        outcome(&setup.run()),
        refused(RewardFloatError::RateAttestationWrongMint)
    );
}

#[test]
fn a_rate_priced_more_than_ten_minutes_ago_is_refused() {
    let mut setup = Setup::first_loan();
    setup.rate.priced_at = NOW - 601;
    assert_eq!(
        outcome(&setup.run()),
        refused(RewardFloatError::RateAttestationStale)
    );
}

#[test]
fn a_debt_worth_less_than_one_reward_unit_is_refused_rather_than_unsecured() {
    // A zero allowance would leave the loan with nothing to be repaid from.
    let mut setup = Setup::first_loan();
    setup.amount = 1;
    setup.rate.rate = u64::MAX;
    setup.max_apr_bps = u16::MAX;
    assert_eq!(
        outcome(&setup.run()),
        refused(RewardFloatError::DelegationTooSmall)
    );
}

#[test]
fn an_allowance_beyond_u64_fails_loud_instead_of_wrapping() {
    let mut setup = Setup::first_loan();
    setup.rate.rate = 1;
    assert_eq!(
        outcome(&setup.run()),
        refused(RewardFloatError::MathOverflow)
    );
}

#[test]
fn a_later_loan_adds_to_the_debt_and_may_reach_the_limit_exactly() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 7;
    setup.operator_state = Some(existing);
    setup.pass_open_loan(&setup.existing_loan(7, AMOUNT));
    setup.pool_state.total_borrowed = AMOUNT;
    setup.vault_balance = DEPOSITS - AMOUNT;
    setup.attestation.nonce = 8;
    setup.nonce = 8;
    setup.amount = LIMIT - AMOUNT;
    // 800 + 2000 × 15 %.
    setup.max_apr_bps = 1_100;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account());
    assert_eq!(operator.owner, setup.signer);
    assert_eq!(operator.total_debt, LIMIT);
    assert_eq!(operator.open_loans, 2);
    assert_eq!(operator.used_nonces[0], (1 << 7) | (1 << 8));
    let loan: Loan = deserialize(&result, &setup.loan());
    assert_eq!(loan.apr_bps, 1_100);
    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!(pool.total_borrowed, LIMIT);
    // One account, one delegate: the allowance covers both loans repaid from it, the old
    // one at 1 000 bps (102 438 356) and the new one at 1 100 (51 356 164).
    assert_eq!(
        delegation(&result, &setup.reward_account),
        Some((setup.operator_account(), 63_903_664_079_127))
    );
}

#[test]
fn an_open_loan_repaid_from_another_token_is_not_in_the_allowance() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 7;
    setup.operator_state = Some(existing);
    let mut other = setup.existing_loan(7, AMOUNT);
    other.reward_mint = Pubkey::new_unique();
    setup.pass_open_loan(&other);
    setup.pool_state.total_borrowed = AMOUNT;
    setup.vault_balance = DEPOSITS - AMOUNT;
    setup.attestation.nonce = 8;
    setup.nonce = 8;
    setup.amount = LIMIT - AMOUNT;
    setup.max_apr_bps = 1_100;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    assert_eq!(
        delegation(&result, &setup.reward_account),
        Some((setup.operator_account(), 21_339_167_693_676))
    );
}

#[test]
fn one_unit_over_the_attested_limit_is_refused() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    setup.operator_state = Some(existing);
    setup.pass_open_loan(&setup.existing_loan(6, AMOUNT));
    setup.amount = LIMIT - AMOUNT + 1;
    setup.max_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::CreditLimitExceeded)
    );
}

#[test]
fn an_operator_with_an_overdue_loan_cannot_borrow() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.overdue = true;
    setup.operator_state = Some(existing);
    let result = setup.run();
    assert_eq!(outcome(&result), refused(RewardFloatError::OperatorOverdue));
}

#[test]
fn more_than_the_free_liquidity_of_the_pool_is_refused() {
    let mut setup = Setup::first_loan();
    setup.pool_state.total_borrowed = DEPOSITS - AMOUNT + 1;
    setup.max_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::InsufficientLiquidity)
    );
}

#[test]
fn a_rate_above_what_the_operator_agreed_to_is_refused() {
    // The screen showed a rate before signing (FR-009a). If utilisation moved in the
    // meantime, the operator gets a refusal, not a dearer loan than they agreed to.
    let mut setup = Setup::first_loan();
    setup.max_apr_bps = APR - 1;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::RateAboveMaximum)
    );
}

#[test]
fn arguments_out_of_range_are_refused() {
    let cases: [(fn(&mut Setup), RewardFloatError); 5] = [
        (|s| s.amount = 0, RewardFloatError::InvalidAmount),
        (|s| s.term_periods = 0, RewardFloatError::InvalidTerm),
        (|s| s.term_periods = 7, RewardFloatError::InvalidTerm),
        (|s| s.sweep_bps = 0, RewardFloatError::InvalidSweepShare),
        (
            |s| s.sweep_bps = 10_001,
            RewardFloatError::InvalidSweepShare,
        ),
    ];
    for (change, expected) in cases {
        let mut setup = Setup::first_loan();
        change(&mut setup);
        assert_eq!(outcome(&setup.run()), refused(expected));
    }
}

#[test]
fn the_longest_term_and_the_whole_payout_are_accepted() {
    let mut setup = Setup::first_loan();
    setup.term_periods = 6;
    setup.sweep_bps = 10_000;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let loan: Loan = deserialize(&result, &setup.loan());
    assert_eq!(loan.due_at, NOW + 6 * REPAYMENT_PERIOD);
    assert_eq!(loan.sweep_bps, 10_000);
}

#[test]
fn the_loan_nonce_has_to_be_the_attested_one() {
    // The loan address is seeded by the nonce argument before the attestation is read.
    // Were it not tied back, one attestation could open loans at any number of addresses.
    let mut setup = Setup::first_loan();
    setup.nonce = 8;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::AttestationNonceMismatch)
    );
}

#[test]
fn without_any_signature_check_before_it_borrow_is_refused() {
    let mut setup = Setup::first_loan();
    setup.limit_check = false;
    setup.rate_check = false;
    let result = setup.run();
    let missing: u32 = RewardFloatError::AttestationMissing.into();
    assert_eq!(
        outcome(&result),
        Err((0, InstructionError::Custom(missing)))
    );
}

#[test]
fn an_attestation_signed_by_another_key_is_refused() {
    let mut setup = Setup::first_loan();
    setup.attestation.signer = SigningKey::from_bytes(&[2; 32]);
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::AttestationWrongSigner)
    );
}

#[test]
fn another_wallet_cannot_borrow_against_an_operator_s_attestation() {
    let mut setup = Setup::first_loan();
    setup.signer = Pubkey::new_unique();
    setup.reward_account = get_associated_token_address(&setup.signer, &setup.reward_mint);
    setup.reward_account_state = reward_token_account(&setup.reward_mint, &setup.signer, None);
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::AttestationWrongOperator)
    );
}

#[test]
fn the_on_chain_clock_decides_that_an_attestation_expired() {
    let mut setup = Setup::first_loan();
    setup.now = setup.attestation.expires_at;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::AttestationExpired)
    );
}

#[test]
fn the_money_goes_out_only_in_the_pool_stablecoin() {
    let mut setup = Setup::first_loan();
    setup.destination_mint = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintTokenMint)
    );
}

#[test]
fn a_vault_other_than_the_pool_s_is_refused() {
    let mut setup = Setup::first_loan();
    setup.vault = Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused_by_anchor(anchor_lang::error::ErrorCode::ConstraintHasOne)
    );
}

#[test]
fn a_forged_signature_fails_the_transaction_in_the_precompile() {
    let mut setup = Setup::first_loan();
    setup.forged = true;
    let result = setup.run();
    let Err((at, _)) = outcome(&result) else {
        panic!("a forged signature went through");
    };
    assert_eq!(
        at, 1,
        "the ed25519 check itself refuses, before borrow runs"
    );
    assert_eq!(account(&result, &setup.loan()).data.len(), 0);
}

#[test]
fn replaying_a_spent_attestation_is_refused_by_the_nonce_mask() {
    // The same attestation in a rebuilt transaction, against the state the first loan
    // left behind: what a wallet does when it retries a borrow that did land.
    let setup = Setup::first_loan();
    let first = setup.run();
    assert_eq!(outcome(&first), Ok(()));

    let mut replay = Setup::first_loan();
    replay.signer = setup.signer;
    replay.attestation.operator = setup.signer;
    replay.destination = setup.destination;
    replay.reward_mint = setup.reward_mint;
    replay.stable_mint = setup.stable_mint;
    replay.destination_mint = setup.stable_mint;
    replay.pool = setup.pool;
    replay.vault = setup.vault;
    replay.rate.mint = setup.reward_mint;
    replay.reward_account = setup.reward_account;
    replay.reward_account_state = account(&first, &setup.reward_account).clone();
    replay.pool_state = deserialize(&first, &setup.pool);
    replay.vault_balance = token_balance(&first, &setup.vault);
    replay.operator_state = Some(deserialize(&first, &setup.operator_account()));
    replay.loan_account = account(&first, &setup.loan()).clone();
    let result = replay.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::AttestationNonceAlreadyUsed)
    );
}

#[test]
fn a_nonce_below_the_floor_is_refused_as_too_old() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.nonce_floor = 100;
    setup.operator_state = Some(existing);
    setup.attestation.nonce = 99;
    setup.nonce = 99;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::AttestationNonceTooOld)
    );
}

#[test]
fn two_attestations_may_be_spent_out_of_order() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = 1;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 8;
    setup.operator_state = Some(existing);
    setup.pass_open_loan(&setup.existing_loan(8, 1));
    setup.max_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let operator: OperatorAccount = deserialize(&result, &setup.operator_account());
    assert_eq!(operator.used_nonces[0], (1 << 7) | (1 << 8));
}

#[test]
fn a_far_nonce_slides_the_window_and_the_account_keeps_it() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 7;
    setup.operator_state = Some(existing);
    setup.pass_open_loan(&setup.existing_loan(7, AMOUNT));
    setup.pool_state.total_borrowed = AMOUNT;
    setup.vault_balance = DEPOSITS - AMOUNT;
    setup.attestation.nonce = 300;
    setup.nonce = 300;
    setup.amount = LIMIT - AMOUNT;
    setup.max_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account());
    let mut expected = fresh_operator_account(setup.signer);
    expected.total_debt = LIMIT;
    expected.open_loans = 2;
    // The window now ends on 300, so it starts at 45 and 7 fell out of it.
    expected.nonce_floor = 45;
    expected.used_nonces = [0, 0, 0, 1 << 63];
    assert_eq!(serialize(&operator), serialize(&expected));
}

#[test]
fn lamports_sent_to_the_loan_address_in_advance_do_not_block_the_loan() {
    // Loan addresses follow from public, dense nonces, so anyone can fund the next one
    // before the operator gets there. Creating the account must not trip over that.
    let clean = Setup::first_loan();
    let rent = account(&clean.run(), &clean.loan()).lamports;

    let mut setup = Setup::first_loan();
    setup.loan_account = Account {
        lamports: 1_000_000,
        ..Account::default()
    };
    assert!(setup.loan_account.lamports < rent);
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    let created = account(&result, &setup.loan());
    assert_eq!(created.owner, m(&reward_float::ID));
    assert_eq!(
        created.lamports, rent,
        "topped up to rent, not charged twice"
    );
    let loan: Loan = deserialize(&result, &setup.loan());
    assert_eq!(loan.nonce, 7);
}

#[test]
fn an_existing_loan_at_the_address_is_a_second_lock_behind_the_mask() {
    // The mask and the loan address can only disagree in a state made up for the test,
    // but if they ever do, the loan that is there must not be written over.
    let mut setup = Setup::first_loan();
    setup.operator_state = Some(fresh_operator_account(setup.signer));
    let other = Setup::first_loan();
    let mut existing: Loan = deserialize(&other.run(), &other.loan());
    existing.operator = setup.signer;
    setup.loan_account = program_account(serialize(&existing));
    let result = setup.run();
    // AccountAlreadyInUse, raised by the System Program under our CPI.
    assert_eq!(outcome(&result), Err((BORROW, InstructionError::Custom(0))));
}

// One open loan of AMOUNT, untouched for a year: 10 % of it is owed and not yet booked.
fn with_a_year_old_open_loan() -> Setup {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = AMOUNT;
    existing.open_loans = 1;
    existing.used_nonces[0] = 1 << 7;
    setup.operator_state = Some(existing);
    let mut loan = setup.existing_loan(7, AMOUNT);
    loan.last_accrual_at = NOW - SECONDS_PER_YEAR;
    setup.pass_open_loan(&loan);
    setup.pool_state.total_borrowed = AMOUNT;
    setup.vault_balance = DEPOSITS - AMOUNT;
    setup.attestation.nonce = 8;
    setup.nonce = 8;
    setup.max_apr_bps = u16::MAX;
    setup
}

const A_YEAR_OF_INTEREST: u64 = AMOUNT / 10;

#[test]
fn interest_accrued_on_open_loans_counts_against_the_limit() {
    let mut setup = with_a_year_old_open_loan();
    setup.amount = LIMIT - AMOUNT - A_YEAR_OF_INTEREST + 1;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::CreditLimitExceeded)
    );
}

#[test]
fn a_loan_up_to_the_limit_books_the_interest_of_the_open_ones_first() {
    let mut setup = with_a_year_old_open_loan();
    setup.amount = LIMIT - AMOUNT - A_YEAR_OF_INTEREST;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    println!(
        "borrow, one open loan: {} CU",
        result.compute_units_consumed
    );
    assert!(result.compute_units_consumed <= 60_000);

    let operator: OperatorAccount = deserialize(&result, &setup.operator_account());
    assert_eq!((operator.total_debt, operator.open_loans), (LIMIT, 2));
    let open: Loan = deserialize(&result, &setup.open_loans[0].0);
    assert_eq!(open.accrued_interest, A_YEAR_OF_INTEREST);
    assert_eq!(open.last_accrual_at, NOW);
    let pool: Pool = deserialize(&result, &setup.pool);
    assert_eq!(pool.accrued_interest, A_YEAR_OF_INTEREST);
    assert_eq!(pool.total_borrowed, LIMIT - A_YEAR_OF_INTEREST);

    // The open loan moved on to NOW and the new one joined, both on the accrual sums.
    let mut expected = setup.pool_state.clone();
    expected.accrual_rate = 0;
    expected.accrual_rate_time = 0;
    expected.accrual_remainders = 0;
    track(&mut expected, &open);
    track(&mut expected, &deserialize::<Loan>(&result, &setup.loan()));
    assert_eq!(
        (
            pool.accrual_rate,
            pool.accrual_rate_time,
            pool.accrual_remainders
        ),
        (
            expected.accrual_rate,
            expected.accrual_rate_time,
            expected.accrual_remainders
        )
    );
}

#[test]
fn every_open_loan_has_to_be_passed() {
    let mut setup = with_a_year_old_open_loan();
    setup.open_loans.clear();
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::OpenLoansMismatch)
    );
}

#[test]
fn only_the_operator_s_own_open_loans_in_this_pool_stand_in() {
    let variants: [fn(&mut Loan); 3] = [
        |loan| loan.operator = Pubkey::new_unique(),
        |loan| loan.pool = Pubkey::new_unique(),
        |loan| {
            loan.status = LoanStatus::Repaid;
            loan.outstanding = 0;
        },
    ];
    for change in variants {
        let mut setup = with_a_year_old_open_loan();
        setup.open_loans.clear();
        let mut loan = setup.existing_loan(7, AMOUNT);
        change(&mut loan);
        setup.pass_open_loan(&loan);
        let result = setup.run();
        assert_eq!(
            outcome(&result),
            refused(RewardFloatError::OpenLoansMismatch)
        );
    }
}

#[test]
fn the_same_loan_cannot_be_passed_twice() {
    let mut setup = with_a_year_old_open_loan();
    let mut existing = setup.operator_state.clone().unwrap();
    existing.open_loans = 2;
    setup.operator_state = Some(existing);
    let twice = setup.open_loans[0].clone();
    setup.open_loans.push(twice);
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::OpenLoansMismatch)
    );
}

#[test]
fn an_open_loan_passed_read_only_is_refused() {
    let mut setup = with_a_year_old_open_loan();
    setup.open_loans[0].2 = false;
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::OpenLoansMismatch)
    );
}

#[test]
fn an_account_that_only_looks_like_a_loan_is_refused() {
    let mut setup = with_a_year_old_open_loan();
    setup.open_loans[0].1.owner = solana_pubkey::Pubkey::new_unique();
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::OpenLoansMismatch)
    );
}

#[test]
fn an_operator_at_the_maximum_of_open_loans_cannot_borrow() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.open_loans = MAX_OPEN_LOANS;
    setup.operator_state = Some(existing);
    let result = setup.run();
    assert_eq!(
        outcome(&result),
        refused(RewardFloatError::TooManyOpenLoans)
    );
}

#[test]
fn the_last_loan_under_the_maximum_stays_within_budget() {
    let mut setup = Setup::first_loan();
    let mut existing = fresh_operator_account(setup.signer);
    existing.total_debt = 3;
    existing.open_loans = MAX_OPEN_LOANS - 1;
    existing.used_nonces[0] = 0b1110;
    setup.operator_state = Some(existing);
    for nonce in 1..=3 {
        let mut loan = setup.existing_loan(nonce, 1);
        loan.last_accrual_at = NOW - SECONDS_PER_YEAR;
        setup.pass_open_loan(&loan);
    }
    setup.max_apr_bps = u16::MAX;
    let result = setup.run();
    assert_eq!(outcome(&result), Ok(()));
    println!(
        "borrow, three open loans: {} CU",
        result.compute_units_consumed
    );
    assert!(result.compute_units_consumed <= 60_000);
    let operator: OperatorAccount = deserialize(&result, &setup.operator_account());
    assert_eq!(operator.open_loans, MAX_OPEN_LOANS);
}
