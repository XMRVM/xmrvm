//! Test fixture: a program that accepts any instruction and reports success without doing
//! anything. It stands in for a malicious "token program" an attacker might pass to the escrow
//! or the AMM in place of the canonical SPL Token program, so the tests can prove those programs
//! pin the token program instead of invoking whatever executable account they are handed.

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

entrypoint!(process_instruction);

fn process_instruction(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    msg!("noop: pretending to have done the work");
    Ok(())
}
