//! Escrow: holds tokens for a buyer until a buyer, seller or arbiter settles the deal.
//!
//! The escrow is a single program-derived address (PDA) that serves two roles at once: it stores
//! the deal's state and it is the SPL owner of the token account holding the funds. Because the
//! PDA has no private key, money can only leave through this program signing with its seeds
//! (`invoke_signed`), which is the property that makes the escrow trustworthy.
//!
//! The PDA is derived from `["escrow", id]`, where `id` is a 32-byte identifier chosen by the
//! client. The token account is created by the client *before* `Initialize` with the PDA set as
//! its SPL owner; the program checks that ownership rather than trusting the caller.
//!
//! # What this program can and cannot guarantee about the asset
//!
//! `Initialize` records the mint in the escrow state and every later instruction requires the
//! funding account, the escrow's token account and the settlement destination to use exactly that
//! recorded mint. That makes an escrow internally consistent: once created it can only ever hold
//! and pay out one asset. It does **not** make the asset valuable. Anyone can create a mint, so a
//! dishonest buyer can open an escrow denominated in a token they printed themselves.
//!
//! **A seller or arbiter must read the mint recorded at bytes 162..194 of the escrow state and
//! check it against the mint they expect (for XMRVM, the runtime's XMR unit mint) before
//! performing any off-chain obligation.** No on-chain check can substitute for that: the program
//! has no way to know which mint the outside world considers real.
//!
//! Instruction layout — one selector byte, then the operands:
//!   0 — `Initialize { id: [u8; 32], amount: u64 }`
//!       accounts: `[escrow(w), buyer(signer,w), mint, buyer_token(w), escrow_token(w), seller,
//!                  arbiter, system_program, token_program]`
//!   1 — `Release` — buyer or arbiter pays the seller.
//!       accounts: `[escrow(w), signer, escrow_token(w), seller_token(w), token_program]`
//!   2 — `Refund` — seller or arbiter returns the funds to the buyer.
//!       accounts: `[escrow(w), signer, escrow_token(w), buyer_token(w), token_program]`

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use spl_token::state::{Account as TokenAccount, Mint};

entrypoint!(process_instruction);

/// Numeric codes surfaced to clients as `ProgramError::Custom(code)`.
#[derive(Clone, Copy)]
#[repr(u32)]
enum EscrowError {
    ZeroAmount = 1,
    AlreadyInitialized = 2,
    WrongEscrowAddress = 3,
    EscrowDoesNotOwnFunds = 4,
    Unauthorized = 5,
    AlreadySettled = 6,
    WrongTokenAccount = 7,
    MalformedState = 8,
    WrongTokenProgram = 9,
    WrongMint = 10,
    NotATokenAccount = 11,
}

impl From<EscrowError> for ProgramError {
    fn from(error: EscrowError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

const STATE_LEN: usize = 202;
const STATUS_ACTIVE: u8 = 1;
const STATUS_RELEASED: u8 = 2;
const STATUS_REFUNDED: u8 = 3;

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (selector, operands) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    match selector {
        0 => initialize(program_id, accounts, operands),
        1 => settle(program_id, accounts, STATUS_RELEASED),
        2 => settle(program_id, accounts, STATUS_REFUNDED),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Deal state, stored as a flat little-endian record so clients can decode it without a library.
struct Escrow {
    status: u8,
    bump: u8,
    id: [u8; 32],
    buyer: Pubkey,
    seller: Pubkey,
    arbiter: Pubkey,
    token: Pubkey,
    mint: Pubkey,
    amount: u64,
}

impl Escrow {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN {
            return Err(EscrowError::MalformedState.into());
        }
        Ok(Escrow {
            status: data[0],
            bump: data[1],
            id: slice32(data, 2)?,
            buyer: Pubkey::new_from_array(slice32(data, 34)?),
            seller: Pubkey::new_from_array(slice32(data, 66)?),
            arbiter: Pubkey::new_from_array(slice32(data, 98)?),
            token: Pubkey::new_from_array(slice32(data, 130)?),
            mint: Pubkey::new_from_array(slice32(data, 162)?),
            amount: u64::from_le_bytes(
                data[194..202]
                    .try_into()
                    .map_err(|_| EscrowError::MalformedState)?,
            ),
        })
    }

    fn write(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != STATE_LEN {
            return Err(EscrowError::MalformedState.into());
        }
        data[0] = self.status;
        data[1] = self.bump;
        data[2..34].copy_from_slice(&self.id);
        data[34..66].copy_from_slice(self.buyer.as_ref());
        data[66..98].copy_from_slice(self.seller.as_ref());
        data[98..130].copy_from_slice(self.arbiter.as_ref());
        data[130..162].copy_from_slice(self.token.as_ref());
        data[162..194].copy_from_slice(self.mint.as_ref());
        data[194..202].copy_from_slice(&self.amount.to_le_bytes());
        Ok(())
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let id: [u8; 32] = operands
        .get(..32)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let amount = u64::from_le_bytes(
        operands
            .get(32..40)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    if amount == 0 {
        return Err(EscrowError::ZeroAmount.into());
    }

    let iter = &mut accounts.iter();
    let escrow = next_account_info(iter)?;
    let buyer = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let buyer_token = next_account_info(iter)?;
    let escrow_token = next_account_info(iter)?;
    let seller = next_account_info(iter)?;
    let arbiter = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    // Pinning the token program comes first: a caller-supplied "token program" that merely
    // returns success would let the escrow record a funded deal while no tokens ever moved.
    require_token_program(token_program)?;
    if !buyer.is_signer {
        return Err(EscrowError::Unauthorized.into());
    }
    if !escrow.data_is_empty() {
        return Err(EscrowError::AlreadyInitialized.into());
    }
    let (expected, bump) = Pubkey::find_program_address(&[b"escrow", &id], program_id);
    if expected != *escrow.key {
        return Err(EscrowError::WrongEscrowAddress.into());
    }

    // The deal is denominated in exactly one mint, and both token accounts must already use it.
    require_mint(mint)?;
    let vault = token_account(escrow_token)?;
    if token_account(buyer_token)?.mint != *mint.key || vault.mint != *mint.key {
        return Err(EscrowError::WrongMint.into());
    }
    // The escrow PDA must already be the SPL owner of the funding account, otherwise the buyer
    // would be depositing into an account somebody else can drain.
    if vault.owner != *escrow.key {
        return Err(EscrowError::EscrowDoesNotOwnFunds.into());
    }

    let rent = Rent::get()?.minimum_balance(STATE_LEN);
    invoke_signed(
        &system_instruction::create_account(
            buyer.key,
            escrow.key,
            rent,
            STATE_LEN as u64,
            program_id,
        ),
        &[buyer.clone(), escrow.clone(), system_program.clone()],
        &[&[b"escrow", &id, &[bump]]],
    )?;

    Escrow {
        status: STATUS_ACTIVE,
        bump,
        id,
        buyer: *buyer.key,
        seller: *seller.key,
        arbiter: *arbiter.key,
        token: *escrow_token.key,
        mint: *mint.key,
        amount,
    }
    .write(&mut escrow.try_borrow_mut_data()?[..])?;

    // The buyer still owns the funds at this point, so this is a plain `invoke` they signed for.
    transfer(
        token_program,
        buyer_token,
        escrow_token,
        buyer,
        amount,
        None,
    )?;
    msg!("escrow: funded with {} units", amount);
    Ok(())
}

/// Shared body of `Release` (`outcome == STATUS_RELEASED`) and `Refund` (`STATUS_REFUNDED`).
fn settle(program_id: &Pubkey, accounts: &[AccountInfo], outcome: u8) -> ProgramResult {
    let iter = &mut accounts.iter();
    let escrow = next_account_info(iter)?;
    let signer = next_account_info(iter)?;
    let escrow_token = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    if escrow.owner != program_id {
        return Err(EscrowError::WrongEscrowAddress.into());
    }
    let mut state = Escrow::read(&escrow.try_borrow_data()?[..])?;
    if state.status != STATUS_ACTIVE {
        return Err(EscrowError::AlreadySettled.into());
    }
    if state.token != *escrow_token.key {
        return Err(EscrowError::WrongTokenAccount.into());
    }

    // Release pays the seller and may be ordered by the buyer or the arbiter; refund returns the
    // money to the buyer and may be ordered by the seller or the arbiter.
    let (beneficiary, first_authority) = if outcome == STATUS_RELEASED {
        (state.seller, state.buyer)
    } else {
        (state.buyer, state.seller)
    };
    if !signer.is_signer || (*signer.key != first_authority && *signer.key != state.arbiter) {
        return Err(EscrowError::Unauthorized.into());
    }
    // The destination must be a real token account for the recorded mint, held by the party the
    // outcome names. The escrow's own account is re-checked for the same reason.
    let paid = token_account(destination)?;
    if token_account(escrow_token)?.mint != state.mint || paid.mint != state.mint {
        return Err(EscrowError::WrongMint.into());
    }
    if paid.owner != beneficiary {
        return Err(EscrowError::WrongTokenAccount.into());
    }

    state.status = outcome;
    state.write(&mut escrow.try_borrow_mut_data()?[..])?;

    // Only the program can sign for the PDA, so the funds move with `invoke_signed`.
    transfer(
        token_program,
        escrow_token,
        destination,
        escrow,
        state.amount,
        Some(&[b"escrow", &state.id, &[state.bump]]),
    )?;
    msg!(
        "escrow: {} {} units",
        if outcome == STATUS_RELEASED { "released" } else { "refunded" },
        state.amount
    );
    Ok(())
}

/// Issues SPL Token `Transfer` (instruction 3), optionally signing for a PDA authority.
fn transfer<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    require_token_program(token_program)?;
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&amount.to_le_bytes());
    let instruction = Instruction {
        program_id: spl_token::ID,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    let infos = [
        source.clone(),
        destination.clone(),
        authority.clone(),
        token_program.clone(),
    ];
    match seeds {
        None => invoke(&instruction, &infos),
        Some(seeds) => invoke_signed(&instruction, &infos, &[seeds]),
    }
}

/// Rejects anything but the canonical SPL Token program.
fn require_token_program(account: &AccountInfo) -> ProgramResult {
    if *account.key != spl_token::ID {
        return Err(EscrowError::WrongTokenProgram.into());
    }
    Ok(())
}

/// Parses an SPL token account, proving the runtime owner is the token program first. Raw byte
/// offsets are never trusted: any program can create a 165-byte account with convincing contents.
fn token_account(account: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if *account.owner != spl_token::ID {
        return Err(EscrowError::NotATokenAccount.into());
    }
    // `unpack` also refuses accounts of the wrong length or in the uninitialized state.
    TokenAccount::unpack(&account.try_borrow_data()?[..])
        .map_err(|_| EscrowError::NotATokenAccount.into())
}

/// Checks that an account really is an initialized SPL mint.
fn require_mint(account: &AccountInfo) -> ProgramResult {
    if *account.owner != spl_token::ID {
        return Err(EscrowError::WrongMint.into());
    }
    Mint::unpack(&account.try_borrow_data()?[..]).map_err(|_| EscrowError::WrongMint)?;
    Ok(())
}

fn slice32(data: &[u8], at: usize) -> Result<[u8; 32], ProgramError> {
    data.get(at..at + 32)
        .ok_or(EscrowError::MalformedState)?
        .try_into()
        .map_err(|_| EscrowError::MalformedState.into())
}
