// Not an instruction of its own: `borrow` (T036) calls this on the Ed25519 instruction
// that precedes it. The runtime has already checked that signature by the time any
// program runs, so what is left here is making sure it is a signature over the right
// bytes by the right key.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

use crate::error::RewardFloatError;

/// First eight bytes of a signed limit attestation, as `packages/shared` writes them.
pub const LIMIT_ATTESTATION_TAG: &[u8; 8] = b"drf:lim1";

/// Tag, operator, limit, computed at, expires at, nonce.
pub const LIMIT_ATTESTATION_LEN: usize = 8 + 32 + 8 + 8 + 8 + 8;

/// The furthest into the future an attestation may still claim to be valid, in seconds.
///
/// The API issues them for five minutes. The other five are for the on-chain clock,
/// which trails wall time. Without this ceiling the program would honour whatever
/// lifetime the API signed, and "centralisation bounded by the validity period" would
/// be a promise of the API, not a property of the program.
pub const MAX_REMAINING_VALIDITY: i64 = 10 * 60;

/// How old the data behind a limit may be, in seconds (FR-007).
pub const MAX_LIMIT_AGE: i64 = 24 * 60 * 60;

/// First eight bytes of a signed rate attestation (FR-015b), as `packages/shared` writes
/// them.
pub const RATE_ATTESTATION_TAG: &[u8; 8] = b"drf:rat1";

/// Tag, reward mint, rate, priced at, expires at.
pub const RATE_ATTESTATION_LEN: usize = 8 + 32 + 8 + 8 + 8;

/// How old the price behind a rate may be, in seconds.
pub const MAX_RATE_AGE: i64 = 10 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateAttestation {
    pub reward_mint: Pubkey,
    pub stable_per_trillion_reward: u64,
    pub priced_at: i64,
    pub expires_at: i64,
}

impl RateAttestation {
    pub fn parse(message: &[u8]) -> Result<Self> {
        let message: &[u8; RATE_ATTESTATION_LEN] = message
            .try_into()
            .map_err(|_| error!(RewardFloatError::AttestationMalformed))?;
        let (tag, rest) = message.split_at(8);
        require!(
            tag == RATE_ATTESTATION_TAG,
            RewardFloatError::AttestationMalformed
        );
        let (mint, rest) = rest.split_at(32);
        let word = |at: usize| -> [u8; 8] { rest[at..at + 8].try_into().unwrap() };
        let attestation = Self {
            reward_mint: Pubkey::new_from_array(mint.try_into().unwrap()),
            stable_per_trillion_reward: u64::from_le_bytes(word(0)),
            priced_at: i64::from_le_bytes(word(8)),
            expires_at: i64::from_le_bytes(word(16)),
        };
        // A zero rate would size any allowance by dividing by it.
        require!(
            attestation.stable_per_trillion_reward > 0,
            RewardFloatError::AttestationMalformed
        );
        Ok(attestation)
    }

    pub fn check(&self, reward_mint: &Pubkey, now: i64) -> Result<()> {
        require_keys_eq!(
            self.reward_mint,
            *reward_mint,
            RewardFloatError::RateAttestationWrongMint
        );
        require!(
            now < self.expires_at,
            RewardFloatError::RateAttestationExpired
        );
        require!(
            self.expires_at.saturating_sub(now) <= MAX_REMAINING_VALIDITY,
            RewardFloatError::RateAttestationValidityTooLong
        );
        require!(
            now.saturating_sub(self.priced_at) <= MAX_RATE_AGE,
            RewardFloatError::RateAttestationStale
        );
        Ok(())
    }
}

/// Reads the rate attestation signed two instructions before the current one, right
/// before the limit's, and checks it against the pool's attestor, the loan's reward
/// token and the clock.
pub fn verify_rate_attestation(
    instructions: &AccountInfo,
    attestor: &Pubkey,
    reward_mint: &Pubkey,
    now: i64,
) -> Result<RateAttestation> {
    let current = load_current_index_checked(instructions)?;
    require!(current > 1, RewardFloatError::AttestationMissing);
    let ix = load_instruction_at_checked(usize::from(current - 2), instructions)?;
    let attestation = RateAttestation::parse(attested_message(&ix, attestor)?)?;
    attestation.check(reward_mint, now)?;
    Ok(attestation)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitAttestation {
    pub operator: Pubkey,
    pub limit: u64,
    pub computed_at: i64,
    pub expires_at: i64,
    pub nonce: u64,
}

impl LimitAttestation {
    pub fn parse(message: &[u8]) -> Result<Self> {
        let message: &[u8; LIMIT_ATTESTATION_LEN] = message
            .try_into()
            .map_err(|_| error!(RewardFloatError::AttestationMalformed))?;
        let (tag, rest) = message.split_at(8);
        require!(
            tag == LIMIT_ATTESTATION_TAG,
            RewardFloatError::AttestationMalformed
        );
        let (operator, rest) = rest.split_at(32);
        let word = |at: usize| -> [u8; 8] { rest[at..at + 8].try_into().unwrap() };
        Ok(Self {
            operator: Pubkey::new_from_array(operator.try_into().unwrap()),
            limit: u64::from_le_bytes(word(0)),
            computed_at: i64::from_le_bytes(word(8)),
            expires_at: i64::from_le_bytes(word(16)),
            nonce: u64::from_le_bytes(word(24)),
        })
    }

    pub fn check(&self, operator: &Pubkey, now: i64) -> Result<()> {
        require_keys_eq!(
            self.operator,
            *operator,
            RewardFloatError::AttestationWrongOperator
        );
        require!(now < self.expires_at, RewardFloatError::AttestationExpired);
        require!(
            self.expires_at.saturating_sub(now) <= MAX_REMAINING_VALIDITY,
            RewardFloatError::AttestationValidityTooLong
        );
        require!(
            now.saturating_sub(self.computed_at) <= MAX_LIMIT_AGE,
            RewardFloatError::AttestationStale
        );
        Ok(())
    }
}

/// Reads the limit attestation signed in the instruction right before the current one
/// and checks it against the pool's attestor, the borrowing operator and the clock.
///
/// The nonce is not consumed here; that belongs to the operator account (FR-012b).
pub fn verify_limit_attestation(
    instructions: &AccountInfo,
    attestor: &Pubkey,
    operator: &Pubkey,
    now: i64,
) -> Result<LimitAttestation> {
    let current = load_current_index_checked(instructions)?;
    require!(current > 0, RewardFloatError::AttestationMissing);
    let ix = load_instruction_at_checked(usize::from(current - 1), instructions)?;
    let attestation = LimitAttestation::parse(attested_message(&ix, attestor)?)?;
    attestation.check(operator, now)?;
    Ok(attestation)
}

// Layout of the ed25519 program's data: a count, a padding byte, then per signature
// seven u16 fields — signature offset and instruction, public key offset and
// instruction, message offset, size and instruction.
const ED25519_OFFSETS_START: usize = 2;
const ED25519_OFFSETS_END: usize = ED25519_OFFSETS_START + 7 * 2;
// Instruction index meaning "the ed25519 instruction itself".
const THIS_INSTRUCTION: u16 = u16::MAX;

fn attested_message<'a>(ix: &'a Instruction, attestor: &Pubkey) -> Result<&'a [u8]> {
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        RewardFloatError::AttestationMissing
    );
    let data = ix.data.as_slice();
    let offsets = data
        .get(ED25519_OFFSETS_START..ED25519_OFFSETS_END)
        .ok_or_else(|| error!(RewardFloatError::AttestationMalformed))?;
    let field = |n: usize| u16::from_le_bytes([offsets[2 * n], offsets[2 * n + 1]]);
    let [_, signature_ix, public_key_at, public_key_ix, message_at, message_len, message_ix] =
        std::array::from_fn(field);

    // The runtime verified whatever the offsets point at. Were any of it read from
    // another instruction, the bytes found here would not be the bytes it verified.
    require!(
        data[0] == 1
            && signature_ix == THIS_INSTRUCTION
            && public_key_ix == THIS_INSTRUCTION
            && message_ix == THIS_INSTRUCTION,
        RewardFloatError::AttestationMalformed
    );
    let slice = |at: u16, len: usize| {
        let at = usize::from(at);
        data.get(at..at + len)
            .ok_or_else(|| error!(RewardFloatError::AttestationMalformed))
    };
    require!(
        slice(public_key_at, 32)? == attestor.as_ref(),
        RewardFloatError::AttestationWrongSigner
    );
    slice(message_at, usize::from(message_len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::{BorrowedAccountMeta, BorrowedInstruction};
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};
    use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_ID;

    // The message `packages/shared` produces for its own golden test, byte for byte:
    // operator 4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy, limit 1 000 000, computed
    // 2026-09-23T10:00:00Z, expires 24 hours later, nonce 7.
    const GOLDEN: &str = concat!(
        "6472663a6c696d31",
        "3a3e72b67ea94e1765004ef68244f6b0b32ddde743a33b20f91430e1e817c1ac",
        "40420f0000000000",
        "20a3b36a00000000",
        "a0f4b46a00000000",
        "0700000000000000",
    );

    const COMPUTED_AT: i64 = 1_790_157_600;

    fn code(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    fn expect(result: Result<impl std::fmt::Debug>, expected: RewardFloatError) {
        let err = result.expect_err("expected a refusal");
        assert_eq!(code(err), code(error!(expected)));
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn message(operator: &Pubkey, computed_at: i64, expires_at: i64) -> Vec<u8> {
        let mut message = LIMIT_ATTESTATION_TAG.to_vec();
        message.extend_from_slice(operator.as_ref());
        message.extend_from_slice(&1_000_000u64.to_le_bytes());
        message.extend_from_slice(&computed_at.to_le_bytes());
        message.extend_from_slice(&expires_at.to_le_bytes());
        message.extend_from_slice(&7u64.to_le_bytes());
        message
    }

    struct Offsets {
        count: u8,
        signature_ix: u16,
        public_key_ix: u16,
        message_ix: u16,
    }

    const OWN: Offsets = Offsets {
        count: 1,
        signature_ix: u16::MAX,
        public_key_ix: u16::MAX,
        message_ix: u16::MAX,
    };

    // The layout solana's `new_ed25519_instruction` produces: a two-byte header, one
    // set of offsets, then public key, signature and message. The signature bytes are
    // never read by the program, so they are left as zeros.
    fn ed25519_data(public_key: &Pubkey, message: &[u8], offsets: Offsets) -> Vec<u8> {
        let public_key_offset: u16 = 16;
        let signature_offset: u16 = public_key_offset + 32;
        let message_offset: u16 = signature_offset + 64;
        let mut data = vec![offsets.count, 0];
        for field in [
            signature_offset,
            offsets.signature_ix,
            public_key_offset,
            offsets.public_key_ix,
            message_offset,
            message.len() as u16,
            offsets.message_ix,
        ] {
            data.extend_from_slice(&field.to_le_bytes());
        }
        data.extend_from_slice(public_key.as_ref());
        data.extend_from_slice(&[0; 64]);
        data.extend_from_slice(message);
        data
    }

    fn ed25519(data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: ed25519_program::ID,
            accounts: vec![],
            data,
        }
    }

    fn borrow() -> Instruction {
        Instruction {
            program_id: crate::ID,
            accounts: vec![],
            data: vec![1, 2, 3],
        }
    }

    // What the runtime hands the program: every instruction of the transaction and the
    // index of the one executing now.
    fn sysvar(instructions: &[Instruction], current: u16) -> Vec<u8> {
        let borrowed: Vec<BorrowedInstruction> = instructions
            .iter()
            .map(|ix| BorrowedInstruction {
                program_id: &ix.program_id,
                accounts: ix
                    .accounts
                    .iter()
                    .map(|meta| BorrowedAccountMeta {
                        pubkey: &meta.pubkey,
                        is_signer: meta.is_signer,
                        is_writable: meta.is_writable,
                    })
                    .collect(),
                data: &ix.data,
            })
            .collect();
        let mut data = construct_instructions_data(&borrowed);
        store_current_index_checked(&mut data, current).unwrap();
        data
    }

    fn verify(
        instructions: &[Instruction],
        current: u16,
        attestor: &Pubkey,
        operator: &Pubkey,
        now: i64,
    ) -> Result<LimitAttestation> {
        let mut data = sysvar(instructions, current);
        let mut lamports = 0;
        let owner = Pubkey::default();
        let account = AccountInfo::new(
            &INSTRUCTIONS_ID,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        verify_limit_attestation(&account, attestor, operator, now)
    }

    struct Case {
        attestor: Pubkey,
        operator: Pubkey,
        now: i64,
        message: Vec<u8>,
    }

    impl Case {
        fn fresh() -> Self {
            let operator = Pubkey::new_unique();
            let now = COMPUTED_AT + 60;
            Self {
                attestor: Pubkey::new_unique(),
                operator,
                now,
                message: message(&operator, COMPUTED_AT, now + 300),
            }
        }

        fn signed(&self) -> Instruction {
            ed25519(ed25519_data(&self.attestor, &self.message, OWN))
        }

        fn run(&self) -> Result<LimitAttestation> {
            verify(
                &[self.signed(), borrow()],
                1,
                &self.attestor,
                &self.operator,
                self.now,
            )
        }
    }

    #[test]
    fn the_message_the_api_signs_is_read_field_by_field() {
        let parsed = LimitAttestation::parse(&unhex(GOLDEN)).unwrap();
        assert_eq!(
            parsed.operator.to_string(),
            "4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy"
        );
        assert_eq!(parsed.limit, 1_000_000);
        assert_eq!(parsed.computed_at, COMPUTED_AT);
        assert_eq!(parsed.expires_at, COMPUTED_AT + 24 * 60 * 60);
        assert_eq!(parsed.nonce, 7);
    }

    #[test]
    fn a_fresh_attestation_by_the_attestor_for_this_operator_passes() {
        let case = Case::fresh();
        let attestation = case.run().unwrap();
        assert_eq!(attestation, LimitAttestation::parse(&case.message).unwrap());
    }

    #[test]
    fn nothing_before_the_current_instruction_is_a_missing_attestation() {
        let case = Case::fresh();
        let result = verify(&[borrow()], 0, &case.attestor, &case.operator, case.now);
        expect(result, RewardFloatError::AttestationMissing);
    }

    #[test]
    fn a_preceding_instruction_of_another_program_is_not_a_signature_check() {
        let case = Case::fresh();
        let mut impostor = case.signed();
        impostor.program_id = Pubkey::new_unique();
        let result = verify(
            &[impostor, borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMissing);
    }

    #[test]
    fn a_signature_check_further_back_does_not_count() {
        let case = Case::fresh();
        let result = verify(
            &[case.signed(), borrow(), borrow()],
            2,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMissing);
    }

    #[test]
    fn a_signature_by_another_key_is_refused() {
        let case = Case::fresh();
        let stranger = Pubkey::new_unique();
        let signed = ed25519(ed25519_data(&stranger, &case.message, OWN));
        let result = verify(
            &[signed, borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationWrongSigner);
    }

    #[test]
    fn a_public_key_taken_from_another_instruction_is_refused() {
        // The precompile would verify against the key found in instruction 0, while the
        // bytes at the offset here could say anything, the attestor's key included.
        let case = Case::fresh();
        let offsets = Offsets {
            public_key_ix: 0,
            ..OWN
        };
        let signed = ed25519(ed25519_data(&case.attestor, &case.message, offsets));
        let result = verify(
            &[signed, borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMalformed);
    }

    #[test]
    fn a_message_taken_from_another_instruction_is_refused() {
        let case = Case::fresh();
        let offsets = Offsets {
            message_ix: 0,
            ..OWN
        };
        let signed = ed25519(ed25519_data(&case.attestor, &case.message, offsets));
        let result = verify(
            &[signed, borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMalformed);
    }

    #[test]
    fn a_signature_taken_from_another_instruction_is_refused() {
        let case = Case::fresh();
        let offsets = Offsets {
            signature_ix: 0,
            ..OWN
        };
        let signed = ed25519(ed25519_data(&case.attestor, &case.message, offsets));
        let result = verify(
            &[signed, borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMalformed);
    }

    #[test]
    fn a_signature_check_of_anything_but_exactly_one_signature_is_refused() {
        for count in [0, 2] {
            let case = Case::fresh();
            let offsets = Offsets { count, ..OWN };
            let signed = ed25519(ed25519_data(&case.attestor, &case.message, offsets));
            let result = verify(
                &[signed, borrow()],
                1,
                &case.attestor,
                &case.operator,
                case.now,
            );
            expect(result, RewardFloatError::AttestationMalformed);
        }
    }

    #[test]
    fn offsets_past_the_end_of_the_data_are_refused_not_a_panic() {
        let case = Case::fresh();
        let mut data = ed25519_data(&case.attestor, &case.message, OWN);
        data.truncate(data.len() - 1);
        let result = verify(
            &[ed25519(data), borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMalformed);

        let result = verify(
            &[ed25519(vec![1, 0, 16]), borrow()],
            1,
            &case.attestor,
            &case.operator,
            case.now,
        );
        expect(result, RewardFloatError::AttestationMalformed);
    }

    #[test]
    fn a_message_of_another_length_is_refused() {
        let mut long = unhex(GOLDEN);
        long.push(0);
        expect(
            LimitAttestation::parse(&long),
            RewardFloatError::AttestationMalformed,
        );
        expect(
            LimitAttestation::parse(&unhex(GOLDEN)[..71]),
            RewardFloatError::AttestationMalformed,
        );
    }

    #[test]
    fn a_message_under_another_tag_is_refused() {
        // The rate attestation (FR-015b) is signed by the same key.
        let mut message = unhex(GOLDEN);
        message[..8].copy_from_slice(b"drf:rat1");
        expect(
            LimitAttestation::parse(&message),
            RewardFloatError::AttestationMalformed,
        );
    }

    #[test]
    fn an_attestation_for_another_operator_is_refused() {
        let mut case = Case::fresh();
        case.operator = Pubkey::new_unique();
        expect(case.run(), RewardFloatError::AttestationWrongOperator);
    }

    #[test]
    fn an_attestation_expires_on_its_expiry_second_not_after_it() {
        let case = Case::fresh();
        let attestation = LimitAttestation::parse(&case.message).unwrap();
        assert!(attestation
            .check(&case.operator, attestation.expires_at - 1)
            .is_ok());
        expect(
            attestation.check(&case.operator, attestation.expires_at),
            RewardFloatError::AttestationExpired,
        );
    }

    #[test]
    fn an_attestation_valid_for_longer_than_the_ceiling_is_refused() {
        let operator = Pubkey::new_unique();
        let now = COMPUTED_AT + 60;
        let at_ceiling = message(&operator, COMPUTED_AT, now + MAX_REMAINING_VALIDITY);
        let attestation = LimitAttestation::parse(&at_ceiling).unwrap();
        assert!(attestation.check(&operator, now).is_ok());

        let past_ceiling = message(&operator, COMPUTED_AT, now + MAX_REMAINING_VALIDITY + 1);
        let attestation = LimitAttestation::parse(&past_ceiling).unwrap();
        expect(
            attestation.check(&operator, now),
            RewardFloatError::AttestationValidityTooLong,
        );
    }

    #[test]
    fn a_far_future_expiry_does_not_overflow_into_a_pass() {
        let operator = Pubkey::new_unique();
        let attestation =
            LimitAttestation::parse(&message(&operator, COMPUTED_AT, i64::MAX)).unwrap();
        expect(
            attestation.check(&operator, i64::MIN + 1),
            RewardFloatError::AttestationValidityTooLong,
        );
    }

    // The message of `packages/shared`'s own golden rate test, byte for byte: mint
    // 4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy, 2 278 438 stablecoin units for 10^12
    // reward units, priced 2026-10-06T10:00:00Z, expiring two minutes later.
    const RATE_GOLDEN: &str = concat!(
        "6472663a72617431",
        "3a3e72b67ea94e1765004ef68244f6b0b32ddde743a33b20f91430e1e817c1ac",
        "26c4220000000000",
        "a0c6c46a00000000",
        "18c7c46a00000000",
    );

    const PRICED_AT: i64 = 1_791_280_800;

    fn rate_message(mint: &Pubkey, rate: u64, priced_at: i64, expires_at: i64) -> Vec<u8> {
        let mut message = RATE_ATTESTATION_TAG.to_vec();
        message.extend_from_slice(mint.as_ref());
        message.extend_from_slice(&rate.to_le_bytes());
        message.extend_from_slice(&priced_at.to_le_bytes());
        message.extend_from_slice(&expires_at.to_le_bytes());
        message
    }

    fn verify_rate(
        instructions: &[Instruction],
        current: u16,
        attestor: &Pubkey,
        mint: &Pubkey,
        now: i64,
    ) -> Result<RateAttestation> {
        let mut data = sysvar(instructions, current);
        let mut lamports = 0;
        let owner = Pubkey::default();
        let account = AccountInfo::new(
            &INSTRUCTIONS_ID,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        verify_rate_attestation(&account, attestor, mint, now)
    }

    struct RateCase {
        limit: Case,
        mint: Pubkey,
        message: Vec<u8>,
    }

    impl RateCase {
        fn fresh() -> Self {
            let limit = Case::fresh();
            let mint = Pubkey::new_unique();
            let message = rate_message(&mint, 2_278_438, limit.now - 30, limit.now + 90);
            Self {
                limit,
                mint,
                message,
            }
        }

        fn signed(&self) -> Instruction {
            ed25519(ed25519_data(&self.limit.attestor, &self.message, OWN))
        }

        fn run(&self, instructions: &[Instruction], current: u16) -> Result<RateAttestation> {
            verify_rate(
                instructions,
                current,
                &self.limit.attestor,
                &self.mint,
                self.limit.now,
            )
        }
    }

    #[test]
    fn the_rate_message_the_api_signs_is_read_field_by_field() {
        let parsed = RateAttestation::parse(&unhex(RATE_GOLDEN)).unwrap();
        assert_eq!(
            parsed.reward_mint.to_string(),
            "4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy"
        );
        assert_eq!(parsed.stable_per_trillion_reward, 2_278_438);
        assert_eq!(parsed.priced_at, PRICED_AT);
        assert_eq!(parsed.expires_at, PRICED_AT + 120);
    }

    #[test]
    fn a_zero_rate_is_refused_as_malformed() {
        let message = rate_message(&Pubkey::new_unique(), 0, PRICED_AT, PRICED_AT + 120);
        expect(
            RateAttestation::parse(&message),
            RewardFloatError::AttestationMalformed,
        );
    }

    #[test]
    fn a_limit_attestation_does_not_parse_as_a_rate() {
        expect(
            RateAttestation::parse(&unhex(GOLDEN)),
            RewardFloatError::AttestationMalformed,
        );
        let mut tagged = unhex(RATE_GOLDEN);
        tagged[..8].copy_from_slice(LIMIT_ATTESTATION_TAG);
        expect(
            RateAttestation::parse(&tagged),
            RewardFloatError::AttestationMalformed,
        );
    }

    #[test]
    fn a_rate_two_instructions_back_by_the_attestor_for_this_mint_passes() {
        let case = RateCase::fresh();
        let rate = case
            .run(&[case.signed(), case.limit.signed(), borrow()], 2)
            .unwrap();
        assert_eq!(rate, RateAttestation::parse(&case.message).unwrap());
    }

    #[test]
    fn without_a_rate_before_the_limit_check_the_rate_is_missing() {
        let case = RateCase::fresh();
        expect(
            case.run(&[case.limit.signed(), borrow()], 1),
            RewardFloatError::AttestationMissing,
        );
        expect(
            case.run(&[borrow(), case.limit.signed(), borrow()], 2),
            RewardFloatError::AttestationMissing,
        );
    }

    #[test]
    fn the_two_signature_checks_in_the_other_order_are_refused() {
        let case = RateCase::fresh();
        expect(
            case.run(&[case.limit.signed(), case.signed(), borrow()], 2),
            RewardFloatError::AttestationMalformed,
        );
    }

    #[test]
    fn a_rate_signed_by_another_key_is_refused() {
        let case = RateCase::fresh();
        let stranger = ed25519(ed25519_data(&Pubkey::new_unique(), &case.message, OWN));
        expect(
            case.run(&[stranger, case.limit.signed(), borrow()], 2),
            RewardFloatError::AttestationWrongSigner,
        );
    }

    #[test]
    fn a_rate_for_another_mint_is_refused() {
        let case = RateCase::fresh();
        let rate = RateAttestation::parse(&case.message).unwrap();
        expect(
            rate.check(&Pubkey::new_unique(), case.limit.now),
            RewardFloatError::RateAttestationWrongMint,
        );
    }

    #[test]
    fn a_rate_expires_on_its_expiry_second_not_after_it() {
        let mint = Pubkey::new_unique();
        let rate =
            RateAttestation::parse(&rate_message(&mint, 1, PRICED_AT, PRICED_AT + 120)).unwrap();
        assert!(rate.check(&mint, PRICED_AT + 119).is_ok());
        expect(
            rate.check(&mint, PRICED_AT + 120),
            RewardFloatError::RateAttestationExpired,
        );
    }

    #[test]
    fn a_rate_valid_for_longer_than_the_ceiling_is_refused() {
        let mint = Pubkey::new_unique();
        let now = PRICED_AT + 10;
        let at_ceiling = rate_message(&mint, 1, PRICED_AT, now + MAX_REMAINING_VALIDITY);
        assert!(RateAttestation::parse(&at_ceiling)
            .unwrap()
            .check(&mint, now)
            .is_ok());
        let past = rate_message(&mint, 1, PRICED_AT, now + MAX_REMAINING_VALIDITY + 1);
        expect(
            RateAttestation::parse(&past).unwrap().check(&mint, now),
            RewardFloatError::RateAttestationValidityTooLong,
        );
    }

    #[test]
    fn a_price_older_than_ten_minutes_is_refused() {
        let mint = Pubkey::new_unique();
        let rate = RateAttestation::parse(&rate_message(
            &mint,
            1,
            PRICED_AT,
            PRICED_AT + MAX_RATE_AGE + 60,
        ))
        .unwrap();
        assert!(rate.check(&mint, PRICED_AT + MAX_RATE_AGE).is_ok());
        expect(
            rate.check(&mint, PRICED_AT + MAX_RATE_AGE + 1),
            RewardFloatError::RateAttestationStale,
        );
    }

    #[test]
    fn a_limit_computed_from_data_older_than_a_day_is_refused() {
        let operator = Pubkey::new_unique();
        let now = COMPUTED_AT + MAX_LIMIT_AGE;
        let attestation =
            LimitAttestation::parse(&message(&operator, COMPUTED_AT, now + 300)).unwrap();
        assert!(attestation.check(&operator, now).is_ok());

        let attestation =
            LimitAttestation::parse(&message(&operator, COMPUTED_AT, now + 301)).unwrap();
        expect(
            attestation.check(&operator, now + 1),
            RewardFloatError::AttestationStale,
        );
    }
}
