//! Budgeted XMR payments executed by an independently held agent key.
//!
//! The policy PDA owns the funded token vault. Its immutable policy fixes the owner,
//! agent, XMR mint, total budget, per-payment limit, expiry and up to eight recipients.
//! Each payment creates a permanent receipt PDA, making retries with a new transaction
//! blockhash unable to charge the same payment ID twice.
//!
//! The XMR mint is pinned by a host-managed config PDA. The runtime writes that account
//! directly from its ledger identity; no program instruction can initialize or change it.
//!
//! Instructions:
//! 0 Create { id[32], budget:u64, max_payment:u64, expires_at:i64,
//!           recipient_count:u8, recipients[recipient_count][32] }
//!   accounts: [policy(w), owner(s,w), agent(w), mint, owner_token(w), vault(w),
//!              config, system_program, token_program]
//! 1 Pay { payment_id[32], amount:u64 }
//!   accounts: [policy(w), agent(s,w), mint, vault(w), recipient,
//!              recipient_token(w), receipt(w), system_program, token_program]
//! 2 Revoke
//!   accounts: [policy(w), owner(s), mint, vault(w), owner_token(w), token_program]
//! 3 ReclaimExpired
//!   accounts: [policy(w), caller(s), mint, vault(w), owner_token(w), token_program]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
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
use std::str::FromStr;

const VERSION: u8 = 1;
const MAX_RECIPIENTS: usize = 8;
const CONFIG_LEN: usize = 33;
const POLICY_LEN: usize = 428;
const RECEIPT_LEN: usize = 114;
const STATUS_ACTIVE: u8 = 1;
const STATUS_REVOKED: u8 = 2;
const STATUS_EXPIRED: u8 = 3;
/// Internal compute/rent credits have no XMR value and are not SPL tokens.
const AGENT_COMPUTE_CREDIT_FLOOR: u64 = 100_000_000;

#[derive(Clone, Copy)]
#[repr(u32)]
enum AgentPaymentError {
    InvalidInstruction = 1,
    WrongProgramConfig = 2,
    ConfigUnavailable = 3,
    InvalidMint = 4,
    InvalidPolicyAddress = 5,
    AlreadyInitialized = 6,
    MalformedState = 7,
    InvalidParticipants = 8,
    InvalidRecipients = 9,
    InvalidBudget = 10,
    InvalidExpiry = 11,
    Unauthorized = 12,
    Inactive = 13,
    Expired = 14,
    RecipientNotAllowed = 15,
    PaymentTooLarge = 16,
    BudgetExceeded = 17,
    WrongTokenAccount = 18,
    WrongTokenProgram = 19,
    NotTokenAccount = 20,
    DuplicatePayment = 21,
    MathOverflow = 22,
}

impl From<AgentPaymentError> for ProgramError {
    fn from(error: AgentPaymentError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (selector, operands) = instruction_data
        .split_first()
        .ok_or(AgentPaymentError::InvalidInstruction)?;
    match selector {
        0 => create(program_id, accounts, operands),
        1 if operands.len() == 40 => pay(program_id, accounts, operands),
        2 if operands.is_empty() => close(program_id, accounts, false),
        3 if operands.is_empty() => close(program_id, accounts, true),
        _ => Err(AgentPaymentError::InvalidInstruction.into()),
    }
}

entrypoint!(process_instruction);

struct Policy {
    status: u8,
    bump: u8,
    recipient_count: u8,
    id: [u8; 32],
    owner: Pubkey,
    agent: Pubkey,
    mint: Pubkey,
    budget: u64,
    max_payment: u64,
    spent: u64,
    expires_at: i64,
    created_at: i64,
    recipients: [[u8; 32]; MAX_RECIPIENTS],
}

impl Policy {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != POLICY_LEN || data[2] == 0 || data[2] as usize > MAX_RECIPIENTS || data[3] != 0 {
            return Err(AgentPaymentError::MalformedState.into());
        }
        let recipient_count = data[2] as usize;
        let mut recipients = [[0u8; 32]; MAX_RECIPIENTS];
        for (index, recipient) in recipients.iter_mut().enumerate() {
            let start = 172 + index * 32;
            recipient.copy_from_slice(data.get(start..start + 32).ok_or(AgentPaymentError::MalformedState)?);
            if index < recipient_count && Pubkey::new_from_array(*recipient) == Pubkey::default() {
                return Err(AgentPaymentError::MalformedState.into());
            }
            if index >= recipient_count && *recipient != [0; 32] {
                return Err(AgentPaymentError::MalformedState.into());
            }
        }
        let state = Self {
            status: data[0],
            bump: data[1],
            recipient_count: data[2],
            id: read32(data, 4)?,
            owner: Pubkey::new_from_array(read32(data, 36)?),
            agent: Pubkey::new_from_array(read32(data, 68)?),
            mint: Pubkey::new_from_array(read32(data, 100)?),
            budget: read_u64(data, 132)?,
            max_payment: read_u64(data, 140)?,
            spent: read_u64(data, 148)?,
            expires_at: read_i64(data, 156)?,
            created_at: read_i64(data, 164)?,
            recipients,
        };
        if !matches!(state.status, STATUS_ACTIVE | STATUS_REVOKED | STATUS_EXPIRED)
            || state.owner == Pubkey::default()
            || state.agent == Pubkey::default()
            || state.mint == Pubkey::default()
            || state.budget == 0
            || state.max_payment == 0
            || state.max_payment > state.budget
            || state.spent > state.budget
            || state.expires_at <= state.created_at
        {
            return Err(AgentPaymentError::MalformedState.into());
        }
        Ok(state)
    }

    fn write(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != POLICY_LEN {
            return Err(AgentPaymentError::MalformedState.into());
        }
        data.fill(0);
        data[0] = self.status;
        data[1] = self.bump;
        data[2] = self.recipient_count;
        data[4..36].copy_from_slice(&self.id);
        data[36..68].copy_from_slice(self.owner.as_ref());
        data[68..100].copy_from_slice(self.agent.as_ref());
        data[100..132].copy_from_slice(self.mint.as_ref());
        data[132..140].copy_from_slice(&self.budget.to_le_bytes());
        data[140..148].copy_from_slice(&self.max_payment.to_le_bytes());
        data[148..156].copy_from_slice(&self.spent.to_le_bytes());
        data[156..164].copy_from_slice(&self.expires_at.to_le_bytes());
        data[164..172].copy_from_slice(&self.created_at.to_le_bytes());
        for (index, recipient) in self.recipients.iter().enumerate() {
            let start = 172 + index * 32;
            data[start..start + 32].copy_from_slice(recipient);
        }
        Ok(())
    }

    fn permits(&self, recipient: &Pubkey) -> bool {
        self.recipients[..self.recipient_count as usize]
            .iter()
            .any(|candidate| Pubkey::new_from_array(*candidate) == *recipient)
    }
}

fn create(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    const FIXED_OPERANDS: usize = 57;
    if operands.len() < FIXED_OPERANDS {
        return Err(AgentPaymentError::InvalidInstruction.into());
    }
    let id = read32(operands, 0)?;
    let budget = read_u64(operands, 32)?;
    let max_payment = read_u64(operands, 40)?;
    let expires_at = read_i64(operands, 48)?;
    let recipient_count = operands[56] as usize;
    if recipient_count == 0 || recipient_count > MAX_RECIPIENTS ||
        operands.len() != FIXED_OPERANDS + recipient_count * 32
    {
        return Err(AgentPaymentError::InvalidRecipients.into());
    }
    if budget == 0 || max_payment == 0 || max_payment > budget {
        return Err(AgentPaymentError::InvalidBudget.into());
    }

    let iter = &mut accounts.iter();
    let policy = next_account_info(iter)?;
    let owner = next_account_info(iter)?;
    let agent = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let owner_token = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_system_program(system_program)?;
    require_token_program(token_program)?;
    if !owner.is_signer {
        return Err(AgentPaymentError::Unauthorized.into());
    }
    if *agent.key == Pubkey::default() || agent.key == owner.key ||
        *agent.owner != solana_program::system_program::ID || !agent.data_is_empty()
    {
        return Err(AgentPaymentError::InvalidParticipants.into());
    }
    validate_config(program_id, config, mint)?;
    let now = Clock::get()?.unix_timestamp;
    if expires_at <= now {
        return Err(AgentPaymentError::InvalidExpiry.into());
    }
    let (expected, bump) = Pubkey::find_program_address(&[b"budget", &id], program_id);
    if expected != *policy.key {
        return Err(AgentPaymentError::InvalidPolicyAddress.into());
    }
    let parsed_owner_token = token_account(owner_token)?;
    let parsed_vault = token_account(vault)?;
    if parsed_owner_token.owner != *owner.key || parsed_owner_token.mint != *mint.key ||
        parsed_vault.owner != *policy.key || parsed_vault.mint != *mint.key
    {
        return Err(AgentPaymentError::WrongTokenAccount.into());
    }

    let mut recipients = [[0u8; 32]; MAX_RECIPIENTS];
    for (index, chunk) in operands[FIXED_OPERANDS..].chunks_exact(32).enumerate() {
        let recipient = Pubkey::new_from_array(read32(chunk, 0)?);
        if recipient == Pubkey::default() || recipient == *owner.key || recipient == *agent.key {
            return Err(AgentPaymentError::InvalidRecipients.into());
        }
        if recipients[..index].iter().any(|existing| existing == recipient.as_ref()) {
            return Err(AgentPaymentError::InvalidRecipients.into());
        }
        recipients[index] = recipient.to_bytes();
    }

    create_pda_account(
        owner,
        policy,
        system_program,
        program_id,
        &[b"budget", &id, &[bump]],
        POLICY_LEN,
    )?;
    let state = Policy {
        status: STATUS_ACTIVE,
        bump,
        recipient_count: recipient_count as u8,
        id,
        owner: *owner.key,
        agent: *agent.key,
        mint: *mint.key,
        budget,
        max_payment,
        spent: 0,
        expires_at,
        created_at: now,
        recipients,
    };
    state.write(&mut policy.try_borrow_mut_data()?[..])?;

    // Give the external signer only non-value internal compute credits. They pay its
    // transaction fees; the signer receives no XMR and cannot access the policy vault.
    let agent_balance = agent.lamports();
    if agent_balance < AGENT_COMPUTE_CREDIT_FLOOR {
        invoke(
            &system_instruction::transfer(
                owner.key,
                agent.key,
                AGENT_COMPUTE_CREDIT_FLOOR - agent_balance,
            ),
            &[owner.clone(), agent.clone(), system_program.clone()],
        )?;
    }
    transfer_tokens(token_program, owner_token, vault, owner, budget, None)?;
    msg!("agent payments: budget created for {} units", budget);
    Ok(())
}

fn pay(program_id: &Pubkey, accounts: &[AccountInfo], operands: &[u8]) -> ProgramResult {
    let payment_id = read32(operands, 0)?;
    let amount = read_u64(operands, 32)?;
    if amount == 0 {
        return Err(AgentPaymentError::InvalidBudget.into());
    }
    let iter = &mut accounts.iter();
    let policy = next_account_info(iter)?;
    let agent = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let recipient_token = next_account_info(iter)?;
    let receipt = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_system_program(system_program)?;
    require_token_program(token_program)?;
    let mut state = active_policy(program_id, policy)?;
    if !agent.is_signer || *agent.key != state.agent {
        return Err(AgentPaymentError::Unauthorized.into());
    }
    if *mint.key != state.mint {
        return Err(AgentPaymentError::InvalidMint.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if now >= state.expires_at {
        return Err(AgentPaymentError::Expired.into());
    }
    if !state.permits(recipient.key) {
        return Err(AgentPaymentError::RecipientNotAllowed.into());
    }
    if amount > state.max_payment {
        return Err(AgentPaymentError::PaymentTooLarge.into());
    }
    let spent = state.spent.checked_add(amount).ok_or(AgentPaymentError::MathOverflow)?;
    if spent > state.budget {
        return Err(AgentPaymentError::BudgetExceeded.into());
    }
    validate_vault(&state, policy, mint, vault)?;
    let destination = token_account(recipient_token)?;
    if destination.owner != *recipient.key || destination.mint != state.mint {
        return Err(AgentPaymentError::WrongTokenAccount.into());
    }

    let (expected_receipt, receipt_bump) =
        Pubkey::find_program_address(&[b"receipt", policy.key.as_ref(), &payment_id], program_id);
    if expected_receipt != *receipt.key {
        return Err(AgentPaymentError::InvalidPolicyAddress.into());
    }
    if !receipt.data_is_empty() || *receipt.owner != solana_program::system_program::ID {
        return Err(AgentPaymentError::DuplicatePayment.into());
    }
    let policy_seeds: &[&[u8]] = &[b"budget", &state.id, &[state.bump]];
    create_pda_account(
        agent,
        receipt,
        system_program,
        program_id,
        &[b"receipt", policy.key.as_ref(), &payment_id, &[receipt_bump]],
        RECEIPT_LEN,
    )?;

    state.spent = spent;
    state.write(&mut policy.try_borrow_mut_data()?[..])?;
    write_receipt(
        receipt,
        receipt_bump,
        policy.key,
        &payment_id,
        recipient.key,
        amount,
        now,
    )?;
    transfer_tokens(
        token_program,
        vault,
        recipient_token,
        policy,
        amount,
        Some(policy_seeds),
    )?;
    msg!("agent payments: paid {} units", amount);
    Ok(())
}

fn close(program_id: &Pubkey, accounts: &[AccountInfo], expired_only: bool) -> ProgramResult {
    let iter = &mut accounts.iter();
    let policy = next_account_info(iter)?;
    let caller = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let owner_token = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    require_token_program(token_program)?;
    let mut state = active_policy(program_id, policy)?;
    if !caller.is_signer {
        return Err(AgentPaymentError::Unauthorized.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if expired_only {
        if now < state.expires_at {
            return Err(AgentPaymentError::Expired.into());
        }
        state.status = STATUS_EXPIRED;
    } else {
        if *caller.key != state.owner {
            return Err(AgentPaymentError::Unauthorized.into());
        }
        state.status = STATUS_REVOKED;
    }
    if *mint.key != state.mint {
        return Err(AgentPaymentError::InvalidMint.into());
    }
    validate_vault(&state, policy, mint, vault)?;
    let destination = token_account(owner_token)?;
    if destination.owner != state.owner || destination.mint != state.mint {
        return Err(AgentPaymentError::WrongTokenAccount.into());
    }

    let held = token_account(vault)?.amount;
    state.write(&mut policy.try_borrow_mut_data()?[..])?;
    if held > 0 {
        transfer_tokens(
            token_program,
            vault,
            owner_token,
            policy,
            held,
            Some(&[b"budget", &state.id, &[state.bump]]),
        )?;
    }
    msg!("agent payments: authorization closed; {} units returned", held);
    Ok(())
}

fn active_policy(program_id: &Pubkey, account: &AccountInfo) -> Result<Policy, ProgramError> {
    if account.owner != program_id {
        return Err(AgentPaymentError::InvalidPolicyAddress.into());
    }
    let state = Policy::read(&account.try_borrow_data()?)?;
    let (expected, bump) = Pubkey::find_program_address(&[b"budget", &state.id], program_id);
    if expected != *account.key || bump != state.bump {
        return Err(AgentPaymentError::InvalidPolicyAddress.into());
    }
    if state.status != STATUS_ACTIVE {
        return Err(AgentPaymentError::Inactive.into());
    }
    Ok(state)
}

fn validate_config(program_id: &Pubkey, config: &AccountInfo, mint: &AccountInfo) -> ProgramResult {
    let (expected, _) = Pubkey::find_program_address(&[b"config"], program_id);
    if expected != *config.key || config.owner != program_id {
        return Err(AgentPaymentError::ConfigUnavailable.into());
    }
    let data = config.try_borrow_data()?;
    if data.len() != CONFIG_LEN || data[0] != VERSION {
        return Err(AgentPaymentError::WrongProgramConfig.into());
    }
    if data[1..33] != mint.key.to_bytes() {
        return Err(AgentPaymentError::InvalidMint.into());
    }
    if *mint.owner != spl_token::ID {
        return Err(AgentPaymentError::InvalidMint.into());
    }
    let parsed = Mint::unpack(&mint.try_borrow_data()?)
        .map_err(|_| AgentPaymentError::InvalidMint)?;
    if parsed.decimals != 12 {
        return Err(AgentPaymentError::InvalidMint.into());
    }
    Ok(())
}

fn validate_vault(
    state: &Policy,
    policy: &AccountInfo,
    mint: &AccountInfo,
    vault: &AccountInfo,
) -> ProgramResult {
    let held = token_account(vault)?;
    if held.owner != *policy.key || held.mint != *mint.key || state.mint != *mint.key {
        return Err(AgentPaymentError::WrongTokenAccount.into());
    }
    Ok(())
}

fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    program_id: &Pubkey,
    seeds: &[&[u8]],
    space: usize,
) -> ProgramResult {
    require_system_program(system_program)?;
    if !target.data_is_empty() || *target.owner != solana_program::system_program::ID {
        return Err(AgentPaymentError::AlreadyInitialized.into());
    }
    let minimum = Rent::get()?.minimum_balance(space);
    if target.lamports() < minimum {
        invoke(
            &system_instruction::transfer(payer.key, target.key, minimum - target.lamports()),
            &[payer.clone(), target.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(target.key, space as u64),
        &[target.clone(), system_program.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(target.key, program_id),
        &[target.clone(), system_program.clone()],
        &[seeds],
    )
}

fn write_receipt(
    receipt: &AccountInfo,
    bump: u8,
    policy: &Pubkey,
    payment_id: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
    created_at: i64,
) -> ProgramResult {
    let mut data = receipt.try_borrow_mut_data()?;
    if data.len() != RECEIPT_LEN {
        return Err(AgentPaymentError::MalformedState.into());
    }
    data[0] = VERSION;
    data[1] = bump;
    data[2..34].copy_from_slice(policy.as_ref());
    data[34..66].copy_from_slice(payment_id);
    data[66..98].copy_from_slice(recipient.as_ref());
    data[98..106].copy_from_slice(&amount.to_le_bytes());
    data[106..114].copy_from_slice(&created_at.to_le_bytes());
    Ok(())
}

fn transfer_tokens<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    require_token_program(token_program)?;
    let mut data = Vec::with_capacity(9);
    data.push(3);
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
    match signer_seeds {
        Some(seeds) => invoke_signed(&instruction, &infos, &[seeds]),
        None => invoke(&instruction, &infos),
    }
}

fn token_account(account: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if *account.owner != spl_token::ID {
        return Err(AgentPaymentError::NotTokenAccount.into());
    }
    TokenAccount::unpack(&account.try_borrow_data()?)
        .map_err(|_| AgentPaymentError::NotTokenAccount.into())
}

fn require_token_program(account: &AccountInfo) -> ProgramResult {
    if *account.key != spl_token::ID {
        return Err(AgentPaymentError::WrongTokenProgram.into());
    }
    Ok(())
}

fn require_system_program(account: &AccountInfo) -> ProgramResult {
    let expected = Pubkey::from_str("11111111111111111111111111111111")
        .map_err(|_| ProgramError::IncorrectProgramId)?;
    if *account.key != expected {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

fn read32(data: &[u8], offset: usize) -> Result<[u8; 32], ProgramError> {
    data.get(offset..offset + 32)
        .ok_or(AgentPaymentError::MalformedState)?
        .try_into()
        .map_err(|_| AgentPaymentError::MalformedState.into())
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or(AgentPaymentError::MalformedState)?
            .try_into()
            .map_err(|_| AgentPaymentError::MalformedState)?,
    ))
}

fn read_i64(data: &[u8], offset: usize) -> Result<i64, ProgramError> {
    Ok(i64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or(AgentPaymentError::MalformedState)?
            .try_into()
            .map_err(|_| AgentPaymentError::MalformedState)?,
    ))
}
