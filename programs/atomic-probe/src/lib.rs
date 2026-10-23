//! Atomic probe: verifies that the XMRVM runtime commits or reverts a transaction as a unit.
//!
//! The whitepaper claims that supported state changes within one transaction commit together or
//! revert together (section 5.2). This program exercises that claim directly, so the guarantee is
//! covered by a test rather than inherited by assumption from the underlying VM.
//!
//! Instruction layout: a single byte selects the behaviour.
//!   0 — `Noop`: succeed without touching accounts. Confirms the program is installed and callable.
//!   1 — `Fail`: return an error after logging, so the whole transaction must revert.
//!   2 — `TransferThenFail`: perform an SPL transfer through CPI and *then* fail, which must leave
//!       token balances unchanged. This is the case that actually proves atomicity.
//!   3 — `Transfer`: perform the same CPI transfer and succeed, as the positive control for case 2.
//!
//! Accounts for cases 2 and 3: `[source, destination, authority, token_program]`, followed by an
//! 8-byte little-endian amount after the selector byte.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (selector, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match selector {
        0 => {
            msg!("atomic-probe: noop");
            Ok(())
        }
        1 => {
            msg!("atomic-probe: failing deliberately");
            Err(ProgramError::Custom(1))
        }
        2 | 3 => {
            let amount = read_amount(rest)?;
            transfer(accounts, amount)?;
            if *selector == 2 {
                msg!("atomic-probe: transfer issued, now failing so it must be rolled back");
                return Err(ProgramError::Custom(2));
            }
            msg!("atomic-probe: transfer committed");
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn read_amount(data: &[u8]) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = data
        .get(..8)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Issues an SPL transfer through cross-program invocation.
fn transfer(accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let source = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    // SPL Token `Transfer` is instruction 3, followed by a little-endian u64 amount.
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&amount.to_le_bytes());

    let instruction = solana_program::instruction::Instruction {
        program_id: *token_program.key,
        accounts: vec![
            solana_program::instruction::AccountMeta::new(*source.key, false),
            solana_program::instruction::AccountMeta::new(*destination.key, false),
            solana_program::instruction::AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };

    invoke(
        &instruction,
        &[source.clone(), destination.clone(), authority.clone(), token_program.clone()],
    )
}
