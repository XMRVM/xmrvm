//! Constant-product AMM: swaps XMR units against an application token with a 0.3% fee.
//!
//! The pool is a program-derived address (PDA) derived from `["pool", id]`. It is both the pool's
//! state record and the SPL owner of the two vault token accounts, so liquidity can only move
//! under this program's `invoke_signed` signature. Each liquidity provider's share of the pool is
//! held in its own PDA derived from `["position", pool, provider]`.
//!
//! Reserves are read live from the two vault token accounts rather than mirrored in state, which
//! removes a whole class of "cached balance drifted from reality" bugs. The pricing rule is the
//! classic `x * y = k` curve: after taking the fee, an input of `dx` returns
//! `dy = y * dx' / (x + dx')` with `dx' = dx * 997 / 1000`, and the product never decreases.
//!
//! Because reserves are live, anyone may donate tokens straight into a vault and inflate the
//! denominator a deposit is priced against. Both liquidity and swap instructions therefore carry
//! a caller-supplied floor on what they must receive (`min_shares`, `min_out`); a deposit or swap
//! that would return less is rejected rather than silently taking a worse price.
//!
//! Instruction layout — one selector byte, then little-endian operands:
//!   0 — `Initialize { id: [u8; 32] }`
//!       accounts: `[pool(w), payer(signer,w), vault_a, vault_b, system_program]`
//!   1 — `AddLiquidity { amount_a: u64, max_b: u64, min_shares: u64 }`
//!       accounts: `[pool(w), position(w), provider(signer,w), provider_a(w), provider_b(w),
//!                  vault_a(w), vault_b(w), system_program, token_program]`
//!   2 — `RemoveLiquidity { shares: u64 }`
//!       accounts: `[pool(w), position(w), provider(signer), provider_a(w), provider_b(w),
//!                  vault_a(w), vault_b(w), token_program]`
//!   3 — `Swap { direction: u8, amount_in: u64, min_out: u64 }` — direction 0 is A→B, 1 is B→A.
//!       accounts: `[pool, user(signer), user_source(w), user_destination(w), vault_in(w),
//!                  vault_out(w), token_program]`

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
use spl_token::state::Account as TokenAccount;

entrypoint!(process_instruction);

/// Numeric codes surfaced to clients as `ProgramError::Custom(code)`.
#[derive(Clone, Copy)]
#[repr(u32)]
enum AmmError {
    ZeroAmount = 1,
    AlreadyInitialized = 2,
    WrongPoolAddress = 3,
    PoolDoesNotOwnVault = 4,
    VaultNotEmpty = 5,
    WrongVault = 6,
    EmptyPool = 7,
    SlippageExceeded = 8,
    InvariantViolated = 9,
    Unauthorized = 10,
    InsufficientShares = 11,
    MalformedState = 12,
    WrongTokenAccount = 13,
    MathOverflow = 14,
    IdenticalMints = 15,
    WrongPosition = 16,
    ExcessiveDeposit = 17,
    WrongTokenProgram = 18,
    SharesBelowMinimum = 19,
    NotATokenAccount = 20,
}

impl From<AmmError> for ProgramError {
    fn from(error: AmmError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

const POOL_LEN: usize = 105;
const POSITION_LEN: usize = 73;
/// 0.3% fee: the swap input is multiplied by 997/1000 before pricing.
const FEE_NUMERATOR: u128 = 997;
const FEE_DENOMINATOR: u128 = 1000;

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
        1 => add_liquidity(program_id, accounts, operands),
        2 => remove_liquidity(program_id, accounts, operands),
        3 => swap(program_id, accounts, operands),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

struct Pool {
    bump: u8,
    id: [u8; 32],
    vault_a: Pubkey,
    vault_b: Pubkey,
    total_shares: u64,
}

impl Pool {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != POOL_LEN {
            return Err(AmmError::MalformedState.into());
        }
        Ok(Pool {
            bump: data[0],
            id: slice32(data, 1)?,
            vault_a: Pubkey::new_from_array(slice32(data, 33)?),
            vault_b: Pubkey::new_from_array(slice32(data, 65)?),
            total_shares: read_u64(data, 97)?,
        })
    }

    fn write(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != POOL_LEN {
            return Err(AmmError::MalformedState.into());
        }
        data[0] = self.bump;
        data[1..33].copy_from_slice(&self.id);
        data[33..65].copy_from_slice(self.vault_a.as_ref());
        data[65..97].copy_from_slice(self.vault_b.as_ref());
        data[97..105].copy_from_slice(&self.total_shares.to_le_bytes());
        Ok(())
    }
}

struct Position {
    bump: u8,
    pool: Pubkey,
    owner: Pubkey,
    shares: u64,
}

impl Position {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != POSITION_LEN {
            return Err(AmmError::MalformedState.into());
        }
        Ok(Position {
            bump: data[0],
            pool: Pubkey::new_from_array(slice32(data, 1)?),
            owner: Pubkey::new_from_array(slice32(data, 33)?),
            shares: read_u64(data, 65)?,
        })
    }

    fn write(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != POSITION_LEN {
            return Err(AmmError::MalformedState.into());
        }
        data[0] = self.bump;
        data[1..33].copy_from_slice(self.pool.as_ref());
        data[33..65].copy_from_slice(self.owner.as_ref());
        data[65..73].copy_from_slice(&self.shares.to_le_bytes());
        Ok(())
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let id = read_id(operands)?;
    let iter = &mut accounts.iter();
    let pool = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let vault_a = next_account_info(iter)?;
    let vault_b = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(AmmError::Unauthorized.into());
    }
    if !pool.data_is_empty() {
        return Err(AmmError::AlreadyInitialized.into());
    }
    let (expected, bump) = Pubkey::find_program_address(&[b"pool", &id], program_id);
    if expected != *pool.key {
        return Err(AmmError::WrongPoolAddress.into());
    }
    // Both vaults must be real SPL accounts already belonging to the pool PDA, and be empty, so
    // that the first deposit alone decides the opening price and share accounting starts at zero.
    let (parsed_a, parsed_b) = (token_account(vault_a)?, token_account(vault_b)?);
    for vault in [&parsed_a, &parsed_b] {
        if vault.owner != *pool.key {
            return Err(AmmError::PoolDoesNotOwnVault.into());
        }
        if vault.amount != 0 {
            return Err(AmmError::VaultNotEmpty.into());
        }
    }
    if parsed_a.mint == parsed_b.mint {
        return Err(AmmError::IdenticalMints.into());
    }

    create_pda(
        payer,
        pool,
        system_program,
        program_id,
        POOL_LEN,
        &[b"pool", &id, &[bump]],
    )?;
    Pool {
        bump,
        id,
        vault_a: *vault_a.key,
        vault_b: *vault_b.key,
        total_shares: 0,
    }
    .write(&mut pool.try_borrow_mut_data()?[..])?;
    msg!("amm: pool initialized");
    Ok(())
}

fn add_liquidity(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let amount_a = read_u64(operands, 0)?;
    let max_b = read_u64(operands, 8)?;
    let min_shares = read_u64(operands, 16)?;
    let iter = &mut accounts.iter();
    let pool_account = next_account_info(iter)?;
    let position_account = next_account_info(iter)?;
    let provider = next_account_info(iter)?;
    let provider_a = next_account_info(iter)?;
    let provider_b = next_account_info(iter)?;
    let vault_a = next_account_info(iter)?;
    let vault_b = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    // Pinning the token program comes first. An impostor that merely returns success would let a
    // provider record shares without depositing anything, then redeem them against real reserves.
    require_token_program(token_program)?;
    if !provider.is_signer {
        return Err(AmmError::Unauthorized.into());
    }
    if amount_a == 0 || max_b == 0 {
        return Err(AmmError::ZeroAmount.into());
    }
    let mut pool = load_pool(program_id, pool_account)?;
    if pool.vault_a != *vault_a.key || pool.vault_b != *vault_b.key {
        return Err(AmmError::WrongVault.into());
    }
    let reserve_a = token_account(vault_a)?.amount;
    let reserve_b = token_account(vault_b)?.amount;

    // The first provider sets the price; later providers must match the current ratio, rounded up
    // so the pool never loses value, and are protected by their own `max_b` ceiling.
    let (amount_b, shares) = if pool.total_shares == 0 {
        (max_b, amount_a)
    } else {
        if reserve_a == 0 || reserve_b == 0 {
            return Err(AmmError::EmptyPool.into());
        }
        let amount_b = mul_div_ceil(amount_a as u128, reserve_b as u128, reserve_a as u128)?;
        if amount_b > max_b {
            return Err(AmmError::ExcessiveDeposit.into());
        }
        let shares = mul_div(amount_a as u128, pool.total_shares as u128, reserve_a as u128)?;
        (amount_b, shares)
    };
    if amount_b == 0 || shares == 0 {
        return Err(AmmError::ZeroAmount.into());
    }
    // Shares are priced against the vaults' live balances, which anybody may inflate by donating
    // to them. `min_shares` is the depositor's own floor and defeats that dilution attack.
    if shares < min_shares {
        return Err(AmmError::SharesBelowMinimum.into());
    }

    let mut position = load_or_create_position(
        program_id,
        position_account,
        pool_account,
        provider,
        system_program,
    )?;
    position.shares = position
        .shares
        .checked_add(shares)
        .ok_or(AmmError::MathOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares)
        .ok_or(AmmError::MathOverflow)?;
    position.write(&mut position_account.try_borrow_mut_data()?[..])?;
    pool.write(&mut pool_account.try_borrow_mut_data()?[..])?;

    transfer(token_program, provider_a, vault_a, provider, amount_a, None)?;
    transfer(token_program, provider_b, vault_b, provider, amount_b, None)?;
    msg!("amm: added {} shares", shares);
    Ok(())
}

fn remove_liquidity(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    operands: &[u8],
) -> ProgramResult {
    let shares = read_u64(operands, 0)?;
    let iter = &mut accounts.iter();
    let pool_account = next_account_info(iter)?;
    let position_account = next_account_info(iter)?;
    let provider = next_account_info(iter)?;
    let provider_a = next_account_info(iter)?;
    let provider_b = next_account_info(iter)?;
    let vault_a = next_account_info(iter)?;
    let vault_b = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    if !provider.is_signer {
        return Err(AmmError::Unauthorized.into());
    }
    if shares == 0 {
        return Err(AmmError::ZeroAmount.into());
    }
    let mut pool = load_pool(program_id, pool_account)?;
    if pool.vault_a != *vault_a.key || pool.vault_b != *vault_b.key {
        return Err(AmmError::WrongVault.into());
    }
    if pool.total_shares == 0 {
        return Err(AmmError::EmptyPool.into());
    }
    if position_account.owner != program_id {
        return Err(AmmError::WrongPosition.into());
    }
    let mut position = Position::read(&position_account.try_borrow_data()?[..])?;
    if position.pool != *pool_account.key || position.owner != *provider.key {
        return Err(AmmError::WrongPosition.into());
    }
    if shares > position.shares {
        return Err(AmmError::InsufficientShares.into());
    }

    // Withdrawals round down, leaving any remainder to the pool rather than to the caller.
    let amount_a = mul_div(
        token_account(vault_a)?.amount as u128,
        shares as u128,
        pool.total_shares as u128,
    )?;
    let amount_b = mul_div(
        token_account(vault_b)?.amount as u128,
        shares as u128,
        pool.total_shares as u128,
    )?;
    if amount_a == 0 || amount_b == 0 {
        return Err(AmmError::ZeroAmount.into());
    }

    position.shares -= shares;
    pool.total_shares -= shares;
    position.write(&mut position_account.try_borrow_mut_data()?[..])?;
    pool.write(&mut pool_account.try_borrow_mut_data()?[..])?;

    let seeds: &[&[u8]] = &[b"pool", &pool.id, std::slice::from_ref(&pool.bump)];
    transfer(
        token_program,
        vault_a,
        provider_a,
        pool_account,
        amount_a,
        Some(seeds),
    )?;
    transfer(
        token_program,
        vault_b,
        provider_b,
        pool_account,
        amount_b,
        Some(seeds),
    )?;
    msg!("amm: removed {} shares", shares);
    Ok(())
}

fn swap(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let direction = *operands.first().ok_or(ProgramError::InvalidInstructionData)?;
    let amount_in = read_u64(operands, 1)?;
    let min_out = read_u64(operands, 9)?;
    let iter = &mut accounts.iter();
    let pool_account = next_account_info(iter)?;
    let user = next_account_info(iter)?;
    let user_source = next_account_info(iter)?;
    let user_destination = next_account_info(iter)?;
    let vault_in = next_account_info(iter)?;
    let vault_out = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    if !user.is_signer {
        return Err(AmmError::Unauthorized.into());
    }
    if amount_in == 0 {
        return Err(AmmError::ZeroAmount.into());
    }
    let pool = load_pool(program_id, pool_account)?;
    let (expected_in, expected_out) = match direction {
        0 => (pool.vault_a, pool.vault_b),
        1 => (pool.vault_b, pool.vault_a),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    if expected_in != *vault_in.key || expected_out != *vault_out.key {
        return Err(AmmError::WrongVault.into());
    }

    let reserve_in = token_account(vault_in)?.amount as u128;
    let reserve_out = token_account(vault_out)?.amount as u128;
    if reserve_in == 0 || reserve_out == 0 {
        return Err(AmmError::EmptyPool.into());
    }

    // dy = y * dx' / (x + dx'), with the 0.3% fee taken off the input first.
    let net_in = (amount_in as u128)
        .checked_mul(FEE_NUMERATOR)
        .ok_or(AmmError::MathOverflow)?
        / FEE_DENOMINATOR;
    if net_in == 0 {
        return Err(AmmError::ZeroAmount.into());
    }
    let denominator = reserve_in.checked_add(net_in).ok_or(AmmError::MathOverflow)?;
    let amount_out = mul_div(reserve_out, net_in, denominator)?;
    if amount_out == 0 {
        return Err(AmmError::ZeroAmount.into());
    }
    if (amount_out as u128) >= reserve_out {
        return Err(AmmError::InvariantViolated.into());
    }
    if amount_out < min_out {
        return Err(AmmError::SlippageExceeded.into());
    }
    // Belt and braces: re-check the curve on the post-trade reserves. The fee means the product
    // should strictly grow; this catches any rounding mistake in the pricing above.
    let new_in = reserve_in
        .checked_add(amount_in as u128)
        .ok_or(AmmError::MathOverflow)?;
    let new_out = reserve_out - amount_out as u128;
    let before = reserve_in
        .checked_mul(reserve_out)
        .ok_or(AmmError::MathOverflow)?;
    let after = new_in.checked_mul(new_out).ok_or(AmmError::MathOverflow)?;
    if after < before {
        return Err(AmmError::InvariantViolated.into());
    }

    transfer(token_program, user_source, vault_in, user, amount_in, None)?;
    transfer(
        token_program,
        vault_out,
        user_destination,
        pool_account,
        amount_out,
        Some(&[b"pool", &pool.id, std::slice::from_ref(&pool.bump)]),
    )?;
    msg!("amm: swapped {} in for {} out", amount_in, amount_out);
    Ok(())
}

fn load_pool(program_id: &Pubkey, pool_account: &AccountInfo) -> Result<Pool, ProgramError> {
    if pool_account.owner != program_id {
        return Err(AmmError::WrongPoolAddress.into());
    }
    let pool = Pool::read(&pool_account.try_borrow_data()?[..])?;
    let expected = Pubkey::create_program_address(
        &[b"pool", &pool.id, std::slice::from_ref(&pool.bump)],
        program_id,
    )
    .map_err(|_| AmmError::WrongPoolAddress)?;
    if expected != *pool_account.key {
        return Err(AmmError::WrongPoolAddress.into());
    }
    Ok(pool)
}

/// Returns the provider's position, creating an empty one on first use.
fn load_or_create_position<'a>(
    program_id: &Pubkey,
    position_account: &AccountInfo<'a>,
    pool_account: &AccountInfo<'a>,
    provider: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
) -> Result<Position, ProgramError> {
    let (expected, bump) = Pubkey::find_program_address(
        &[b"position", pool_account.key.as_ref(), provider.key.as_ref()],
        program_id,
    );
    if expected != *position_account.key {
        return Err(AmmError::WrongPosition.into());
    }
    if position_account.data_is_empty() {
        create_pda(
            provider,
            position_account,
            system_program,
            program_id,
            POSITION_LEN,
            &[
                b"position",
                pool_account.key.as_ref(),
                provider.key.as_ref(),
                &[bump],
            ],
        )?;
        return Ok(Position {
            bump,
            pool: *pool_account.key,
            owner: *provider.key,
            shares: 0,
        });
    }
    if position_account.owner != program_id {
        return Err(AmmError::WrongPosition.into());
    }
    let position = Position::read(&position_account.try_borrow_data()?[..])?;
    if position.pool != *pool_account.key || position.owner != *provider.key {
        return Err(AmmError::WrongPosition.into());
    }
    Ok(position)
}

/// Creates a rent-exempt account at a PDA this program owns.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    program_id: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(payer.key, account.key, rent, space as u64, program_id),
        &[payer.clone(), account.clone(), system_program.clone()],
        &[seeds],
    )
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
        return Err(AmmError::WrongTokenProgram.into());
    }
    Ok(())
}

/// Parses an SPL token account, proving the runtime owner is the token program first. Raw byte
/// offsets are never trusted: any program can create a 165-byte account with convincing contents.
fn token_account(account: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if *account.owner != spl_token::ID {
        return Err(AmmError::NotATokenAccount.into());
    }
    // `unpack` also refuses accounts of the wrong length or in the uninitialized state.
    TokenAccount::unpack(&account.try_borrow_data()?[..])
        .map_err(|_| AmmError::NotATokenAccount.into())
}

/// `a * b / d`, rounded down, computed in u128 and checked back into u64.
fn mul_div(a: u128, b: u128, d: u128) -> Result<u64, ProgramError> {
    if d == 0 {
        return Err(AmmError::MathOverflow.into());
    }
    let product = a.checked_mul(b).ok_or(AmmError::MathOverflow)?;
    u64::try_from(product / d).map_err(|_| AmmError::MathOverflow.into())
}

/// `a * b / d`, rounded up.
fn mul_div_ceil(a: u128, b: u128, d: u128) -> Result<u64, ProgramError> {
    if d == 0 {
        return Err(AmmError::MathOverflow.into());
    }
    let product = a.checked_mul(b).ok_or(AmmError::MathOverflow)?;
    let quotient = product / d + u128::from(product % d != 0);
    u64::try_from(quotient).map_err(|_| AmmError::MathOverflow.into())
}

fn read_id(operands: &[u8]) -> Result<[u8; 32], ProgramError> {
    operands
        .get(..32)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)
}

fn read_u64(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = data
        .get(at..at + 8)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes))
}

fn slice32(data: &[u8], at: usize) -> Result<[u8; 32], ProgramError> {
    data.get(at..at + 32)
        .ok_or(AmmError::MalformedState)?
        .try_into()
        .map_err(|_| AmmError::MalformedState.into())
}
