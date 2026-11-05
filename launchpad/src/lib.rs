//! Launchpad: anyone creates a fixed-supply token that trades against XMR on a bonding curve and,
//! once the curve sells out, graduates: its liquidity migrates to a pool on Solana.
//!
//! # Supply
//!
//! `Create` mints the whole supply — 1,000,000,000 tokens with 6 decimals — into the curve's own
//! token vault and then removes the mint authority, so no more tokens can ever exist. Nobody
//! receives an allocation: the creator, like everyone else, gets tokens only by buying them.
//!
//! # Price
//!
//! The curve uses pump.fun's model: a constant product `x * y = k` over *virtual* reserves that
//! start at `INITIAL_VIRTUAL_XMR` and `INITIAL_VIRTUAL_TOKEN`. Of the supply, `INITIAL_REAL_TOKEN`
//! (793.1M) is sold on the curve; the remaining 206.9M stays in the vault. When the curve's last
//! token is bought the token *graduates*: trading on XMRVM stops and its liquidity migrates to a
//! constant-product pool on Solana, opened at the curve's last price with the 206.9M tokens and
//! the collected XMR's value in SOL (see the runtime's Solana bridge).
//!
//! # Migration
//!
//! After graduation the 206.9M tokens stay in the token vault for good: they back the tokens the
//! bridge puts into the Solana pool. The collected XMR stays in the XMR vault until the XMRVM
//! runtime (the XMR mint authority) moves it once with `ClaimMigrationXmr` into its own reserve,
//! to swap it for the pool's SOL. No instruction moves the tokens out of a graduated vault.
//!
//! # Fees
//!
//! Every trade pays `CREATOR_FEE_BPS` to the token's creator and `PROTOCOL_FEE_BPS` to the
//! platform, in XMR, on top of a buy or out of a sale. `BUYBACK_SHARE_BPS` of the platform fee
//! (half) goes to the buyback vault instead: only the XMRVM runtime can move it, with
//! `ClaimBuybackXmr`, to buy back and burn the project's token on Solana. The other half and the
//! creator fee accumulate in vaults claimed with `ClaimProtocolFees` / `ClaimCreatorFees`.
//!
//! `Create` also charges a fixed `CREATION_FEE` in XMR, from the creator's XMR account into the
//! platform fee vault: it covers the graduation's real costs (Raydium pool fee, rent, swap spread).
//!
//! # The XMR asset
//!
//! `Create` records the quote mint at bytes 106..138 of the curve state. Anyone can create a mint,
//! so clients must only show curves whose recorded mint is the runtime's XMR unit mint.
//!
//! # Platform authority
//!
//! Fixed when the program is built (`XMRVM_LAUNCHPAD_AUTHORITY`). It can pause new token creation
//! and claim its half of the protocol fees. It cannot change parameters, move any curve's funds or
//! touch the buyback vault.
//!
//! Instruction layout — one selector byte, then little-endian operands:
//!   0 — `Create { id: [u8; 32], creator_wallet: [u8; 32], name, symbol, description, website, x, telegram }`
//!       (wallet is the user's Phantom destination; each text field is a length byte followed by UTF-8)
//!       accounts: `[creator(signer,w), curve(w), mint(w), token_vault(w), xmr_vault(w), xmr_mint,
//!                  creator_fee_vault(w), protocol_fee_vault(w), fee_authority, config,
//!                  system_program, token_program, buyback_vault(w), creator_xmr(w)]`
//!       — `creator_xmr` is the creator's XMR token account; it pays `CREATION_FEE`.
//!   1 — `Buy { max_xmr: u64, min_tokens: u64 }` — spends at most `max_xmr` including fees.
//!   2 — `Sell { tokens: u64, min_xmr: u64 }` — `min_xmr` is the amount received after fees.
//!       accounts (both): `[trader(signer), curve(w), token_vault(w), xmr_vault(w), trader_xmr(w),
//!                  trader_token(w), creator_fee_vault(w), protocol_fee_vault(w), token_program,
//!                  buyback_vault(w)]`
//!   3 — `ClaimCreatorFees` — accounts: `[creator(signer), creator_fee_vault(w), destination(w),
//!                  fee_authority, xmr_mint, token_program]`
//!   4 — `ClaimProtocolFees` — accounts: `[authority(signer), protocol_fee_vault(w),
//!                  destination(w), fee_authority, xmr_mint, token_program]`
//!   5 — `SetPaused { paused: u8 }` — accounts: `[authority(signer,w), config(w), system_program]`
//!   6 — `ClaimMigrationXmr` — accounts: `[runtime(signer), curve(w), xmr_vault(w), reserve_vault(w),
//!                  xmr_mint, token_program]` — signed by the XMR mint authority, into its reserve vault,
//!                  only for a graduated token, only once.
//!   7 — `ClaimBuybackXmr` — accounts: `[runtime(signer), buyback_vault(w), reserve_vault(w),
//!                  fee_authority, xmr_mint, token_program]` — signed by the XMR mint authority, the
//!                  whole buyback vault into its reserve vault.

use std::str::FromStr;

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token::{
    instruction as token_ix,
    state::{Account as TokenAccount, Mint},
};

entrypoint!(process_instruction);

pub const DECIMALS: u8 = 6;
/// 1,000,000,000 tokens at 6 decimals.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
pub const INITIAL_VIRTUAL_TOKEN: u64 = 1_073_000_000_000_000;
/// Tokens sold on the curve; the rest of the supply seeds the pool at graduation.
pub const INITIAL_REAL_TOKEN: u64 = 793_100_000_000_000;
/// 4.75 XMR in piconero (1 XMR = 10^12).
#[cfg(not(any(feature = "staging", feature = "staging-micro", feature = "staging-swap")))]
pub const INITIAL_VIRTUAL_XMR: u64 = 4_750_000_000_000;
/// Private staging build only: every price and the XMR a curve collects are 1/100 of the real
/// curve (graduation at about 0.1346 XMR), so a full launch can be tested with little real XMR.
/// Token amounts, supply and the pool share are unchanged. Never install it as the public launchpad.
#[cfg(all(feature = "staging", not(any(feature = "staging-micro", feature = "staging-swap"))))]
pub const INITIAL_VIRTUAL_XMR: u64 = 47_500_000_000;
/// Micro-staging only: 1/10,000 prices, graduation at about 0.001346 XMR.
#[cfg(all(feature = "staging-micro", not(feature = "staging-swap")))]
pub const INITIAL_VIRTUAL_XMR: u64 = 475_000_000;
/// Separate real-swap staging: approximately 0.03 XMR at graduation.
#[cfg(feature = "staging-swap")]
pub const INITIAL_VIRTUAL_XMR: u64 = 4_750_000_000_000 / 450;
/// One-off creation cost in piconero, paid by the creator to the platform fee vault. It covers
/// what a graduation spends: Raydium's 0.15 SOL pool fee, pool and mint rent, Solana fees and the
/// XMR→SOL swap spread (0.25 XMR on the public launchpad).
#[cfg(not(any(feature = "staging", feature = "staging-micro", feature = "staging-swap")))]
pub const CREATION_FEE: u64 = 250_000_000_000;
/// Staging builds: the same real SOL costs (about 0.034 XMR) plus the small curve's swap spread.
#[cfg(any(feature = "staging", feature = "staging-micro", feature = "staging-swap"))]
pub const CREATION_FEE: u64 = 35_000_000_000;
pub const CREATOR_FEE_BPS: u64 = 30;
pub const PROTOCOL_FEE_BPS: u64 = 95;
/// Share of the protocol fee that goes to the buyback vault (5,000 = half).
pub const BUYBACK_SHARE_BPS: u64 = 5_000;
const BPS: u64 = 10_000;
const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const PHASE_CURVE: u8 = 1;
/// Graduated: no trading on XMRVM; the collected XMR waits in the vault for `ClaimMigrationXmr`.
const PHASE_GRADUATED: u8 = 2;
/// Graduated and the collected XMR claimed by the platform.
const PHASE_MIGRATED: u8 = 3;
const STATE_VERSION: u8 = 1;

const NAME_MAX: usize = 32;
const SYMBOL_MAX: usize = 10;
const DESCRIPTION_MAX: usize = 160;
const LINK_MAX: usize = 64;

/// Numeric codes surfaced to clients as `ProgramError::Custom(code)`.
#[derive(Clone, Copy)]
#[repr(u32)]
enum LaunchpadError {
    ZeroAmount = 1,
    AlreadyInitialized = 2,
    WrongAddress = 3,
    Unauthorized = 4,
    SlippageExceeded = 5,
    WrongTokenProgram = 6,
    WrongMint = 7,
    MalformedState = 8,
    InvalidText = 9,
    CreationsPaused = 10,
    InsufficientLiquidity = 11,
    NotATokenAccount = 12,
    /// The token graduated: it trades on Solana now.
    Graduated = 13,
    /// The token has not graduated, or its XMR was already claimed.
    NotGraduated = 14,
    /// The creator's XMR account cannot pay `CREATION_FEE`.
    CreationFeeUnpaid = 15,
}

impl From<LaunchpadError> for ProgramError {
    fn from(error: LaunchpadError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (selector, operands) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match selector {
        0 => create(program_id, accounts, operands),
        1 => trade(program_id, accounts, operands, true),
        2 => trade(program_id, accounts, operands, false),
        3 => claim_creator_fees(program_id, accounts),
        4 => claim_protocol_fees(program_id, accounts),
        5 => set_paused(program_id, accounts, operands),
        6 => claim_migration_xmr(program_id, accounts),
        7 => claim_buyback_xmr(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The platform authority this binary was built for, or the all-zero key (nobody) if unset.
fn platform_authority() -> Pubkey {
    option_env!("XMRVM_LAUNCHPAD_AUTHORITY")
        .and_then(|value| Pubkey::from_str(value).ok())
        .unwrap_or_default()
}

// ---- State ----------------------------------------------------------------------------------

const LEGACY_STATE_LEN: usize = 746;
const STATE_LEN: usize = 778;

/// The fields trading needs. Identity and metadata are written once by `create` and only read
/// by clients.
struct Curve {
    phase: u8,
    curve_bump: u8,
    mint: Pubkey,
    token_vault: Pubkey,
    xmr_vault: Pubkey,
    creator_fee_vault: Pubkey,
    protocol_fee_vault: Pubkey,
    virtual_xmr: u64,
    virtual_token: u64,
    real_xmr: u64,
    real_token: u64,
    graduated_at: i64,
    last_trade_at: i64,
    trades: u64,
    volume_xmr: u64,
}

fn key_at(data: &[u8], at: usize) -> Result<Pubkey, ProgramError> {
    let bytes: [u8; 32] = data
        .get(at..at + 32)
        .ok_or(LaunchpadError::MalformedState)?
        .try_into()
        .map_err(|_| LaunchpadError::MalformedState)?;
    Ok(Pubkey::new_from_array(bytes))
}

fn u64_at(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        data.get(at..at + 8)
            .ok_or(LaunchpadError::MalformedState)?
            .try_into()
            .map_err(|_| LaunchpadError::MalformedState)?,
    ))
}

impl Curve {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if !matches!(data.len(), LEGACY_STATE_LEN | STATE_LEN)
            || data[0] != STATE_VERSION || !(PHASE_CURVE..=PHASE_MIGRATED).contains(&data[1]) {
            return Err(LaunchpadError::MalformedState.into());
        }
        Ok(Curve {
            phase: data[1],
            curve_bump: data[2],
            mint: key_at(data, 42)?,
            token_vault: key_at(data, 138)?,
            xmr_vault: key_at(data, 170)?,
            creator_fee_vault: key_at(data, 202)?,
            protocol_fee_vault: key_at(data, 234)?,
            virtual_xmr: u64_at(data, 266)?,
            virtual_token: u64_at(data, 274)?,
            real_xmr: u64_at(data, 282)?,
            real_token: u64_at(data, 290)?,
            graduated_at: u64_at(data, 314)? as i64,
            last_trade_at: u64_at(data, 322)? as i64,
            trades: u64_at(data, 330)?,
            volume_xmr: u64_at(data, 338)?,
        })
    }

    /// Writes the trading fields. Identity, vaults and metadata are written once by `create`.
    fn write_trading(&self, data: &mut [u8]) -> ProgramResult {
        if !matches!(data.len(), LEGACY_STATE_LEN | STATE_LEN) {
            return Err(LaunchpadError::MalformedState.into());
        }
        data[1] = self.phase;
        data[266..274].copy_from_slice(&self.virtual_xmr.to_le_bytes());
        data[274..282].copy_from_slice(&self.virtual_token.to_le_bytes());
        data[282..290].copy_from_slice(&self.real_xmr.to_le_bytes());
        data[290..298].copy_from_slice(&self.real_token.to_le_bytes());
        data[314..322].copy_from_slice(&self.graduated_at.to_le_bytes());
        data[322..330].copy_from_slice(&self.last_trade_at.to_le_bytes());
        data[330..338].copy_from_slice(&self.trades.to_le_bytes());
        data[338..346].copy_from_slice(&self.volume_xmr.to_le_bytes());
        Ok(())
    }
}

// ---- Create ---------------------------------------------------------------------------------

/// Reads one length-prefixed UTF-8 field without control characters.
fn take_text<'a>(input: &mut &'a [u8], max: usize, required: bool) -> Result<&'a [u8], ProgramError> {
    let (&len, rest) = input.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let len = len as usize;
    if len > max || (required && len == 0) || rest.len() < len {
        return Err(LaunchpadError::InvalidText.into());
    }
    let (text, rest) = rest.split_at(len);
    let valid = core::str::from_utf8(text).map_err(|_| LaunchpadError::InvalidText)?;
    if valid.chars().any(|c| c.is_control()) || (required && valid.trim().is_empty()) {
        return Err(LaunchpadError::InvalidText.into());
    }
    *input = rest;
    Ok(text)
}

fn write_text(data: &mut [u8], at: usize, max: usize, text: &[u8]) {
    data[at] = text.len() as u8;
    data[at + 1..at + 1 + text.len()].copy_from_slice(text);
    for byte in &mut data[at + 1 + text.len()..at + 1 + max] {
        *byte = 0;
    }
}

fn create(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let id: [u8; 32] = operands.get(..32).ok_or(ProgramError::InvalidInstructionData)?
        .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let creator_wallet = Pubkey::new_from_array(
        operands.get(32..64).ok_or(ProgramError::InvalidInstructionData)?
            .try_into().map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let mut rest = &operands[64..];
    let name = take_text(&mut rest, NAME_MAX, true)?;
    let symbol = take_text(&mut rest, SYMBOL_MAX, true)?;
    let description = take_text(&mut rest, DESCRIPTION_MAX, false)?;
    let website = take_text(&mut rest, LINK_MAX, false)?;
    let x = take_text(&mut rest, LINK_MAX, false)?;
    let telegram = take_text(&mut rest, LINK_MAX, false)?;
    if !rest.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let creator = next_account_info(iter)?;
    let curve = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_vault = next_account_info(iter)?;
    let xmr_vault = next_account_info(iter)?;
    let xmr_mint = next_account_info(iter)?;
    let creator_fee_vault = next_account_info(iter)?;
    let protocol_fee_vault = next_account_info(iter)?;
    let fee_authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let buyback_vault = next_account_info(iter)?;
    let creator_xmr = next_account_info(iter)?;

    require_token_program(token_program)?;
    if *system.key != system_program::ID {
        return Err(LaunchpadError::WrongAddress.into());
    }
    if !creator.is_signer {
        return Err(LaunchpadError::Unauthorized.into());
    }
    let (config_key, _) = Pubkey::find_program_address(&[b"config"], program_id);
    if *config.key != config_key {
        return Err(LaunchpadError::WrongAddress.into());
    }
    if config.owner == program_id && config.try_borrow_data()?.get(1) == Some(&1) {
        return Err(LaunchpadError::CreationsPaused.into());
    }
    require_mint(xmr_mint)?;

    let (mint_key, mint_bump) = Pubkey::find_program_address(&[b"mint", &id], program_id);
    let (curve_key, curve_bump) = Pubkey::find_program_address(&[b"curve", mint_key.as_ref()], program_id);
    let (token_vault_key, token_vault_bump) = Pubkey::find_program_address(&[b"token-vault", mint_key.as_ref()], program_id);
    let (xmr_vault_key, xmr_vault_bump) = Pubkey::find_program_address(&[b"xmr-vault", mint_key.as_ref()], program_id);
    let (creator_vault_key, creator_vault_bump) = Pubkey::find_program_address(
        &[b"creator-fees", creator.key.as_ref(), xmr_mint.key.as_ref()], program_id);
    let (protocol_vault_key, protocol_vault_bump) = Pubkey::find_program_address(
        &[b"protocol-fees", xmr_mint.key.as_ref()], program_id);
    let (fee_authority_key, _) = Pubkey::find_program_address(&[b"fees"], program_id);
    let (buyback_vault_key, buyback_vault_bump) = Pubkey::find_program_address(
        &[b"buyback", xmr_mint.key.as_ref()], program_id);
    if *mint.key != mint_key || *curve.key != curve_key || *token_vault.key != token_vault_key
        || *xmr_vault.key != xmr_vault_key || *creator_fee_vault.key != creator_vault_key
        || *protocol_fee_vault.key != protocol_vault_key || *fee_authority.key != fee_authority_key
        || *buyback_vault.key != buyback_vault_key
    {
        return Err(LaunchpadError::WrongAddress.into());
    }
    if !curve.data_is_empty() || !mint.data_is_empty() {
        return Err(LaunchpadError::AlreadyInitialized.into());
    }
    let payer = token_account(creator_xmr)?;
    if payer.mint != *xmr_mint.key {
        return Err(LaunchpadError::WrongMint.into());
    }
    if payer.owner != *creator.key || payer.amount < CREATION_FEE {
        return Err(LaunchpadError::CreationFeeUnpaid.into());
    }

    let mint_seeds: &[&[u8]] = &[b"mint", &id, &[mint_bump]];
    let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve_bump]];

    // The mint: 6 decimals, the curve as mint authority until the supply exists, no freeze authority.
    create_pda(creator, mint, system, Mint::LEN, &spl_token::ID, mint_seeds)?;
    invoke(
        &token_ix::initialize_mint2(&spl_token::ID, mint.key, curve.key, None, DECIMALS)?,
        &[mint.clone(), token_program.clone()],
    )?;
    create_token_account(creator, token_vault, mint, curve.key, system, token_program,
        &[b"token-vault", mint_key.as_ref(), &[token_vault_bump]])?;
    create_token_account(creator, xmr_vault, xmr_mint, curve.key, system, token_program,
        &[b"xmr-vault", mint_key.as_ref(), &[xmr_vault_bump]])?;
    if creator_fee_vault.data_is_empty() {
        create_token_account(creator, creator_fee_vault, xmr_mint, fee_authority.key, system, token_program,
            &[b"creator-fees", creator.key.as_ref(), xmr_mint.key.as_ref(), &[creator_vault_bump]])?;
    }
    if protocol_fee_vault.data_is_empty() {
        create_token_account(creator, protocol_fee_vault, xmr_mint, fee_authority.key, system, token_program,
            &[b"protocol-fees", xmr_mint.key.as_ref(), &[protocol_vault_bump]])?;
    }
    if buyback_vault.data_is_empty() {
        create_token_account(creator, buyback_vault, xmr_mint, fee_authority.key, system, token_program,
            &[b"buyback", xmr_mint.key.as_ref(), &[buyback_vault_bump]])?;
    }
    transfer(token_program, creator_xmr, protocol_fee_vault, creator, CREATION_FEE, None)?;

    // The whole supply goes to the curve, then the mint authority is removed for good.
    invoke_signed(
        &token_ix::mint_to(&spl_token::ID, mint.key, token_vault.key, curve.key, &[], TOTAL_SUPPLY)?,
        &[mint.clone(), token_vault.clone(), curve.clone(), token_program.clone()],
        &[curve_seeds],
    )?;
    invoke_signed(
        &token_ix::set_authority(&spl_token::ID, mint.key, None, token_ix::AuthorityType::MintTokens, curve.key, &[])?,
        &[mint.clone(), curve.clone(), token_program.clone()],
        &[curve_seeds],
    )?;

    create_pda(creator, curve, system, STATE_LEN, program_id, curve_seeds)?;
    let now = Clock::get()?.unix_timestamp;
    let mut guard = curve.try_borrow_mut_data()?;
    let data: &mut [u8] = &mut guard;
    data[0] = STATE_VERSION;
    data[1] = PHASE_CURVE;
    data[2] = curve_bump;
    data[3] = token_vault_bump;
    data[4] = xmr_vault_bump;
    data[5] = mint_bump;
    data[6..8].copy_from_slice(&(CREATOR_FEE_BPS as u16).to_le_bytes());
    data[8..10].copy_from_slice(&(PROTOCOL_FEE_BPS as u16).to_le_bytes());
    data[10..42].copy_from_slice(&id);
    data[42..74].copy_from_slice(mint.key.as_ref());
    data[74..106].copy_from_slice(creator.key.as_ref());
    data[106..138].copy_from_slice(xmr_mint.key.as_ref());
    data[138..170].copy_from_slice(token_vault.key.as_ref());
    data[170..202].copy_from_slice(xmr_vault.key.as_ref());
    data[202..234].copy_from_slice(creator_fee_vault.key.as_ref());
    data[234..266].copy_from_slice(protocol_fee_vault.key.as_ref());
    data[266..274].copy_from_slice(&INITIAL_VIRTUAL_XMR.to_le_bytes());
    data[274..282].copy_from_slice(&INITIAL_VIRTUAL_TOKEN.to_le_bytes());
    data[282..290].copy_from_slice(&0u64.to_le_bytes());
    data[290..298].copy_from_slice(&INITIAL_REAL_TOKEN.to_le_bytes());
    data[298..306].copy_from_slice(&TOTAL_SUPPLY.to_le_bytes());
    data[306..314].copy_from_slice(&now.to_le_bytes());
    data[314..346].fill(0);
    write_text(data, 346, NAME_MAX, name);
    write_text(data, 379, SYMBOL_MAX, symbol);
    write_text(data, 390, DESCRIPTION_MAX, description);
    write_text(data, 551, LINK_MAX, website);
    write_text(data, 616, LINK_MAX, x);
    write_text(data, 681, LINK_MAX, telegram);
    data[746..778].copy_from_slice(creator_wallet.as_ref());
    drop(guard);
    msg!("launchpad:create fee {}", CREATION_FEE);
    Ok(())
}

// ---- Trading --------------------------------------------------------------------------------

fn ceil_div(numerator: u128, denominator: u128) -> u128 {
    numerator.div_ceil(denominator)
}

fn trade(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8], buy: bool) -> ProgramResult {
    if operands.len() != 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64_at(operands, 0)?;
    let limit = u64_at(operands, 8)?;

    let iter = &mut accounts.iter();
    let trader = next_account_info(iter)?;
    let curve = next_account_info(iter)?;
    let token_vault = next_account_info(iter)?;
    let xmr_vault = next_account_info(iter)?;
    let trader_xmr = next_account_info(iter)?;
    let trader_token = next_account_info(iter)?;
    let creator_fee_vault = next_account_info(iter)?;
    let protocol_fee_vault = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let buyback_vault = next_account_info(iter)?;

    require_token_program(token_program)?;
    if !trader.is_signer {
        return Err(LaunchpadError::Unauthorized.into());
    }
    if curve.owner != program_id {
        return Err(LaunchpadError::WrongAddress.into());
    }
    let (mut state, recorded_mint) = {
        let data = curve.try_borrow_data()?;
        (Curve::read(&data)?, key_at(&data, 106)?)
    };
    let buyback_key = Pubkey::find_program_address(&[b"buyback", recorded_mint.as_ref()], program_id).0;
    if *token_vault.key != state.token_vault || *xmr_vault.key != state.xmr_vault
        || *buyback_vault.key != buyback_key
        || *creator_fee_vault.key != state.creator_fee_vault || *protocol_fee_vault.key != state.protocol_fee_vault
    {
        return Err(LaunchpadError::WrongAddress.into());
    }
    if amount == 0 {
        return Err(LaunchpadError::ZeroAmount.into());
    }
    if state.phase != PHASE_CURVE {
        return Err(LaunchpadError::Graduated.into());
    }

    let vx = state.virtual_xmr as u128;
    let vt = state.virtual_token as u128;
    let (xmr, tokens, creator_fee, protocol_fee);
    if buy {
        // Fees are charged on top of what goes into the curve, so the budget covers both.
        let mut net = amount as u128 * BPS as u128 / (BPS + CREATOR_FEE_BPS + PROTOCOL_FEE_BPS) as u128;
        let mut out = vt * net / (vx + net);
        if out >= state.real_token as u128 {
            // The curve sells out: take exactly what is left and charge only for that.
            out = state.real_token as u128;
            net = ceil_div(vx * out, vt - out);
        }
        if out == 0 || net == 0 {
            return Err(LaunchpadError::ZeroAmount.into());
        }
        if out < limit as u128 {
            return Err(LaunchpadError::SlippageExceeded.into());
        }
        creator_fee = (net * CREATOR_FEE_BPS as u128 / BPS as u128) as u64;
        protocol_fee = (net * PROTOCOL_FEE_BPS as u128 / BPS as u128) as u64;
        xmr = net as u64;
        tokens = out as u64;
        if xmr as u128 + creator_fee as u128 + protocol_fee as u128 > amount as u128 {
            return Err(LaunchpadError::SlippageExceeded.into());
        }
        state.virtual_xmr += xmr;
        state.virtual_token -= tokens;
        state.real_xmr += xmr;
        state.real_token -= tokens;
    } else {
        let gross = vx * amount as u128 / (vt + amount as u128);
        if gross > state.real_xmr as u128 {
            return Err(LaunchpadError::InsufficientLiquidity.into());
        }
        creator_fee = (gross * CREATOR_FEE_BPS as u128 / BPS as u128) as u64;
        protocol_fee = (gross * PROTOCOL_FEE_BPS as u128 / BPS as u128) as u64;
        let payout = gross as u64 - creator_fee - protocol_fee;
        if payout == 0 {
            return Err(LaunchpadError::ZeroAmount.into());
        }
        if payout < limit {
            return Err(LaunchpadError::SlippageExceeded.into());
        }
        xmr = gross as u64;
        tokens = amount;
        state.virtual_xmr -= xmr;
        state.virtual_token += tokens;
        state.real_xmr -= xmr;
        state.real_token += tokens;
    }

    let now = Clock::get()?.unix_timestamp;
    let graduated = buy && state.real_token == 0;
    if graduated {
        // Trading stops; the virtual reserves keep the curve's last price for the Solana pool.
        state.phase = PHASE_GRADUATED;
        state.graduated_at = now;
    }
    state.trades = state.trades.saturating_add(1);
    state.volume_xmr = state.volume_xmr.saturating_add(xmr);
    state.last_trade_at = now;
    state.write_trading(&mut curve.try_borrow_mut_data()?[..])?;

    let curve_seeds: &[&[u8]] = &[b"curve", state.mint.as_ref(), &[state.curve_bump]];
    // Half of the platform fee is set aside for the buyback; only the runtime can move it.
    let buyback_fee = (protocol_fee as u128 * BUYBACK_SHARE_BPS as u128 / BPS as u128) as u64;
    let platform_fee = protocol_fee - buyback_fee;
    if buy {
        transfer(token_program, trader_xmr, xmr_vault, trader, xmr, None)?;
        transfer(token_program, trader_xmr, creator_fee_vault, trader, creator_fee, None)?;
        transfer(token_program, trader_xmr, protocol_fee_vault, trader, platform_fee, None)?;
        transfer(token_program, trader_xmr, buyback_vault, trader, buyback_fee, None)?;
        transfer(token_program, token_vault, trader_token, curve, tokens, Some(curve_seeds))?;
    } else {
        transfer(token_program, trader_token, token_vault, trader, tokens, None)?;
        transfer(token_program, xmr_vault, trader_xmr, curve, xmr - creator_fee - protocol_fee, Some(curve_seeds))?;
        transfer(token_program, xmr_vault, creator_fee_vault, curve, creator_fee, Some(curve_seeds))?;
        transfer(token_program, xmr_vault, protocol_fee_vault, curve, platform_fee, Some(curve_seeds))?;
        transfer(token_program, xmr_vault, buyback_vault, curve, buyback_fee, Some(curve_seeds))?;
    }
    msg!(
        "launchpad:trade {} {} {} {} {} {} {}",
        if buy { "buy" } else { "sell" },
        xmr,
        tokens,
        creator_fee + protocol_fee,
        state.virtual_xmr,
        state.virtual_token,
        now
    );
    if graduated {
        msg!("launchpad:graduated {} {}", state.real_xmr, TOTAL_SUPPLY - INITIAL_REAL_TOKEN);
    }
    Ok(())
}

/// Moves a graduated token's collected XMR into the runtime's reserve vault, once, so the runtime
/// can swap it for the SOL side of the token's Solana pool.
///
/// Only the XMR mint authority can sign — that is the XMRVM runtime itself, the only party that
/// can create or redeem XMR units — and the destination must be its own reserve vault (its
/// associated token account for the XMR mint). No person, the platform authority included, can
/// move this XMR anywhere.
fn claim_migration_xmr(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let curve = next_account_info(iter)?;
    let xmr_vault = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let xmr_mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    if curve.owner != program_id {
        return Err(LaunchpadError::WrongAddress.into());
    }
    let (mut state, recorded_mint) = {
        let data = curve.try_borrow_data()?;
        (Curve::read(&data)?, key_at(&data, 106)?)
    };
    if *xmr_vault.key != state.xmr_vault || *xmr_mint.key != recorded_mint {
        return Err(LaunchpadError::WrongAddress.into());
    }
    require_mint(xmr_mint)?;
    let mint = Mint::unpack(&xmr_mint.try_borrow_data()?[..]).map_err(|_| LaunchpadError::WrongMint)?;
    if !authority.is_signer || mint.mint_authority != COption::Some(*authority.key) {
        return Err(LaunchpadError::Unauthorized.into());
    }
    let reserve = Pubkey::find_program_address(
        &[authority.key.as_ref(), spl_token::ID.as_ref(), xmr_mint.key.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    ).0;
    if *destination.key != reserve {
        return Err(LaunchpadError::WrongAddress.into());
    }
    if state.phase != PHASE_GRADUATED {
        return Err(LaunchpadError::NotGraduated.into());
    }
    let amount = state.real_xmr;
    state.phase = PHASE_MIGRATED;
    state.write_trading(&mut curve.try_borrow_mut_data()?[..])?;
    let curve_seeds: &[&[u8]] = &[b"curve", state.mint.as_ref(), &[state.curve_bump]];
    transfer(token_program, xmr_vault, destination, curve, amount, Some(curve_seeds))?;
    msg!("launchpad:migration-claimed {}", amount);
    Ok(())
}

/// Moves the whole buyback vault into the runtime's reserve vault, so the runtime can swap it for
/// the project's token on Solana and burn it. Same rule as `ClaimMigrationXmr`: only the XMR mint
/// authority (the runtime) signs, and only towards its own reserve vault.
fn claim_buyback_xmr(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let fee_authority = next_account_info(iter)?;
    let xmr_mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    require_mint(xmr_mint)?;
    let mint = Mint::unpack(&xmr_mint.try_borrow_data()?[..]).map_err(|_| LaunchpadError::WrongMint)?;
    if !authority.is_signer || mint.mint_authority != COption::Some(*authority.key) {
        return Err(LaunchpadError::Unauthorized.into());
    }
    let reserve = Pubkey::find_program_address(
        &[authority.key.as_ref(), spl_token::ID.as_ref(), xmr_mint.key.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    ).0;
    let expected = Pubkey::find_program_address(&[b"buyback", xmr_mint.key.as_ref()], program_id).0;
    let (fee_authority_key, fee_bump) = Pubkey::find_program_address(&[b"fees"], program_id);
    if *destination.key != reserve || *vault.key != expected || *fee_authority.key != fee_authority_key {
        return Err(LaunchpadError::WrongAddress.into());
    }
    let balance = token_account(vault)?.amount;
    if balance == 0 {
        return Err(LaunchpadError::ZeroAmount.into());
    }
    transfer(token_program, vault, destination, fee_authority, balance, Some(&[b"fees", &[fee_bump]]))?;
    msg!("launchpad:buyback-claimed {}", balance);
    Ok(())
}

// ---- Fees and administration ----------------------------------------------------------------

fn claim(program_id: &Pubkey, accounts: &[AccountInfo], creator_vault: bool) -> ProgramResult {
    let iter = &mut accounts.iter();
    let signer = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let fee_authority = next_account_info(iter)?;
    let xmr_mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    if !signer.is_signer {
        return Err(LaunchpadError::Unauthorized.into());
    }
    let expected = if creator_vault {
        Pubkey::find_program_address(&[b"creator-fees", signer.key.as_ref(), xmr_mint.key.as_ref()], program_id).0
    } else {
        let authority = platform_authority();
        if authority == Pubkey::default() || *signer.key != authority {
            return Err(LaunchpadError::Unauthorized.into());
        }
        Pubkey::find_program_address(&[b"protocol-fees", xmr_mint.key.as_ref()], program_id).0
    };
    let (fee_authority_key, fee_bump) = Pubkey::find_program_address(&[b"fees"], program_id);
    if *vault.key != expected || *fee_authority.key != fee_authority_key {
        return Err(LaunchpadError::WrongAddress.into());
    }
    let balance = token_account(vault)?.amount;
    if balance == 0 {
        return Err(LaunchpadError::ZeroAmount.into());
    }
    transfer(token_program, vault, destination, fee_authority, balance, Some(&[b"fees", &[fee_bump]]))?;
    msg!("launchpad:claim {} {}", if creator_vault { "creator" } else { "protocol" }, balance);
    Ok(())
}

fn claim_creator_fees(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    claim(program_id, accounts, true)
}

fn claim_protocol_fees(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    claim(program_id, accounts, false)
}

fn set_paused(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let paused = match operands {
        [0] => 0u8,
        [1] => 1u8,
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let expected = platform_authority();
    if !authority.is_signer || expected == Pubkey::default() || *authority.key != expected {
        return Err(LaunchpadError::Unauthorized.into());
    }
    let (config_key, bump) = Pubkey::find_program_address(&[b"config"], program_id);
    if *config.key != config_key || *system.key != system_program::ID {
        return Err(LaunchpadError::WrongAddress.into());
    }
    if config.data_is_empty() {
        create_pda(authority, config, system, 8, program_id, &[b"config", &[bump]])?;
    }
    let mut data = config.try_borrow_mut_data()?;
    data[0] = 1;
    data[1] = paused;
    msg!("launchpad:paused {}", paused);
    Ok(())
}

// ---- Helpers --------------------------------------------------------------------------------

/// Creates a program-derived account. An address someone pre-funded with lamports (to make
/// `create_account` fail) is completed with allocate + assign instead, so it cannot be blocked.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(space);
    if target.lamports() == 0 {
        return invoke_signed(
            &system_instruction::create_account(payer.key, target.key, rent, space as u64, owner),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        );
    }
    if *target.owner != system_program::ID || !target.data_is_empty() {
        return Err(LaunchpadError::AlreadyInitialized.into());
    }
    let missing = rent.saturating_sub(target.lamports());
    if missing > 0 {
        invoke(
            &system_instruction::transfer(payer.key, target.key, missing),
            &[payer.clone(), target.clone(), system.clone()],
        )?;
    }
    invoke_signed(&system_instruction::allocate(target.key, space as u64), &[target.clone(), system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(target.key, owner), &[target.clone(), system.clone()], &[seeds])
}

fn create_token_account<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    owner: &Pubkey,
    system: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    seeds: &[&[u8]],
) -> ProgramResult {
    create_pda(payer, account, system, TokenAccount::LEN, &spl_token::ID, seeds)?;
    invoke(
        &token_ix::initialize_account3(&spl_token::ID, account.key, mint.key, owner)?,
        &[account.clone(), mint.clone(), token_program.clone()],
    )
}

/// SPL Token `Transfer`, optionally signed by a program-derived authority. Zero amounts are skipped.
fn transfer<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let instruction = token_ix::transfer(&spl_token::ID, source.key, destination.key, authority.key, &[], amount)?;
    let infos = [source.clone(), destination.clone(), authority.clone(), token_program.clone()];
    match seeds {
        None => invoke(&instruction, &infos),
        Some(seeds) => invoke_signed(&instruction, &infos, &[seeds]),
    }
}

fn require_token_program(account: &AccountInfo) -> ProgramResult {
    if *account.key != spl_token::ID {
        return Err(LaunchpadError::WrongTokenProgram.into());
    }
    Ok(())
}

fn token_account(account: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if *account.owner != spl_token::ID {
        return Err(LaunchpadError::NotATokenAccount.into());
    }
    TokenAccount::unpack(&account.try_borrow_data()?[..]).map_err(|_| LaunchpadError::NotATokenAccount.into())
}

fn require_mint(account: &AccountInfo) -> ProgramResult {
    if *account.owner != spl_token::ID {
        return Err(LaunchpadError::WrongMint.into());
    }
    Mint::unpack(&account.try_borrow_data()?[..]).map_err(|_| LaunchpadError::WrongMint)?;
    Ok(())
}
