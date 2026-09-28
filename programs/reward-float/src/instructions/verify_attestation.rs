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
