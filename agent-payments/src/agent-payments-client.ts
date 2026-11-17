import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from './escrow-client.js';

export const AGENT_CONFIG_SIZE = 33;
export const AGENT_POLICY_SIZE = 428;
export const AGENT_RECEIPT_SIZE = 114;
export const AGENT_MAX_RECIPIENTS = 8;
export const AGENT_COMPUTE_CREDIT_FLOOR = 100_000_000n;
export const AGENT_POLICY_OFFSETS = { owner: 36, agent: 68, mint: 100 } as const;
export const AGENT_RECEIPT_STATUS = { active: 1, revoked: 2, expired: 3 } as const;
export type AgentPolicyStatus = keyof typeof AGENT_RECEIPT_STATUS;

export interface AgentPolicyState {
  status: AgentPolicyStatus;
  id: Uint8Array;
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  budget: bigint;
  maxPayment: bigint;
  spent: bigint;
  expiresAt: number;
  createdAt: number;
  recipients: PublicKey[];
}

export interface AgentPaymentReceipt {
  policy: PublicKey;
  paymentId: Uint8Array;
  recipient: PublicKey;
  amount: bigint;
  createdAt: number;
}

export const AGENT_PAYMENT_ERRORS: Record<number, string> = {
  2: 'Agent payments are not configured for the official XMR mint.',
  3: 'The host-managed agent-payments configuration is unavailable.',
  4: 'This is not the official XMRVM XMR mint.',
  5: 'The budget or payment receipt address is invalid.',
  6: 'This budget or payment ID already exists.',
  7: 'The on-chain authorization data is malformed.',
  8: 'The owner and agent must be different valid accounts.',
  9: 'Provide between one and eight distinct recipient accounts.',
  10: 'The budget and per-payment limit must be positive, and the limit cannot exceed the budget.',
  11: 'The authorization expiry must be in the future.',
  12: 'This signer is not authorized for this action.',
  13: 'This authorization is no longer active.',
  14: 'The authorization has expired.',
  15: 'This recipient is not authorized by the policy.',
  16: 'The payment exceeds the per-payment limit.',
  17: 'The payment exceeds the total budget remaining.',
  18: 'The token account does not match the authorized owner and mint.',
  19: 'Only the canonical SPL Token program is supported.',
  20: 'The supplied account is not a valid SPL Token account.',
  21: 'This payment ID has already been used.',
  22: 'The payment total overflowed.',
};

function u64(value: bigint, label: string): Uint8Array {
  if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} must be between 1 and u64::MAX.`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64(value: number, label: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive Unix seconds.`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
  return bytes;
}

function id32(id: Uint8Array, label: string): Uint8Array {
  if (id.length !== 32) throw new Error(`${label} must be exactly 32 bytes.`);
  return id;
}

export function deriveAgentConfigAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('config')], programId)[0];
}

export function deriveAgentBudgetAddress(programId: PublicKey, id: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('budget'), Buffer.from(id32(id, 'Budget ID'))], programId,
  )[0];
}

export function deriveAgentReceiptAddress(
  programId: PublicKey, policy: PublicKey, paymentId: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('receipt'), policy.toBuffer(), Buffer.from(id32(paymentId, 'Payment ID'))],
    programId,
  )[0];
}

export function createAgentBudgetInstruction(accounts: {
  programId: PublicKey;
  policy: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  ownerToken: PublicKey;
  vault: PublicKey;
  config: PublicKey;
  id: Uint8Array;
  budget: bigint;
  maxPayment: bigint;
  expiresAt: number;
  recipients: PublicKey[];
}): TransactionInstruction {
  id32(accounts.id, 'Budget ID');
  if (accounts.recipients.length < 1 || accounts.recipients.length > AGENT_MAX_RECIPIENTS) {
    throw new RangeError(`Provide between one and ${AGENT_MAX_RECIPIENTS} recipients.`);
  }
  if (accounts.owner.equals(accounts.agent) || accounts.agent.equals(PublicKey.default)) {
    throw new Error('The owner and agent must be different valid accounts.');
  }
  if (accounts.budget <= 0n || accounts.maxPayment <= 0n || accounts.maxPayment > accounts.budget) {
    throw new RangeError('The per-payment limit must be positive and no greater than the budget.');
  }
  const unique = new Set(accounts.recipients.map((recipient) => recipient.toBase58()));
  if (unique.size !== accounts.recipients.length ||
      accounts.recipients.some((recipient) => recipient.equals(PublicKey.default) ||
        recipient.equals(accounts.owner) || recipient.equals(accounts.agent))) {
    throw new Error('Recipients must be distinct and cannot be the owner, agent or zero address.');
  }

  const data = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(accounts.id),
    Buffer.from(u64(accounts.budget, 'Budget')),
    Buffer.from(u64(accounts.maxPayment, 'Per-payment limit')),
    Buffer.from(i64(accounts.expiresAt, 'Expiry')),
    Buffer.from([accounts.recipients.length]),
    ...accounts.recipients.map((recipient) => recipient.toBuffer()),
  ]);
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.policy, isSigner: false, isWritable: true },
      { pubkey: accounts.owner, isSigner: true, isWritable: true },
      { pubkey: accounts.agent, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.ownerToken, isSigner: false, isWritable: true },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function createAgentPaymentInstruction(accounts: {
  programId: PublicKey;
  policy: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  recipient: PublicKey;
  recipientToken: PublicKey;
  receipt: PublicKey;
  paymentId: Uint8Array;
  amount: bigint;
}): TransactionInstruction {
  id32(accounts.paymentId, 'Payment ID');
  const data = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(accounts.paymentId),
    Buffer.from(u64(accounts.amount, 'Payment amount')),
  ]);
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.policy, isSigner: false, isWritable: true },
      { pubkey: accounts.agent, isSigner: true, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.recipient, isSigner: false, isWritable: false },
      { pubkey: accounts.recipientToken, isSigner: false, isWritable: true },
      { pubkey: accounts.receipt, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function createRevokeAgentBudgetInstruction(accounts: {
  programId: PublicKey;
  policy: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  ownerToken: PublicKey;
}): TransactionInstruction {
  return closeInstruction(accounts, 2);
}

export function createReclaimExpiredAgentBudgetInstruction(accounts: {
  programId: PublicKey;
  policy: PublicKey;
  caller: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  ownerToken: PublicKey;
}): TransactionInstruction {
  return closeInstruction({
    ...accounts,
    owner: accounts.caller,
  }, 3);
}

function closeInstruction(
  accounts: {
    programId: PublicKey; policy: PublicKey; owner: PublicKey; mint: PublicKey;
    vault: PublicKey; ownerToken: PublicKey;
  },
  selector: 2 | 3,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.policy, isSigner: false, isWritable: true },
      { pubkey: accounts.owner, isSigner: true, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.ownerToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([selector]),
  });
}

export function decodeAgentConfig(data: Uint8Array): PublicKey {
  if (data.length !== AGENT_CONFIG_SIZE || data[0] !== 1) throw new Error('Invalid agent-payments config account.');
  return new PublicKey(data.slice(1, 33));
}

export function decodeAgentPolicy(data: Uint8Array): AgentPolicyState {
  if (data.length !== AGENT_POLICY_SIZE || data[2]! < 1 || data[2]! > AGENT_MAX_RECIPIENTS || data[3] !== 0) {
    throw new Error('Invalid agent-payments policy account.');
  }
  const status = (Object.entries(AGENT_RECEIPT_STATUS)
    .find(([, value]) => value === data[0])?.[0]) as AgentPolicyStatus | undefined;
  if (!status) throw new Error('Unknown agent-payments policy status.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const time = (offset: number) => Number(view.getBigInt64(offset, true));
  const amount = (offset: number) => view.getBigUint64(offset, true);
  const recipientCount = data[2]!;
  const recipients = Array.from({ length: recipientCount }, (_, index) =>
    new PublicKey(data.slice(172 + index * 32, 204 + index * 32)));
  if (new Set(recipients.map((recipient) => recipient.toBase58())).size !== recipients.length ||
      data.slice(172 + recipientCount * 32).some((byte) => byte !== 0)) {
    throw new Error('Malformed agent-payments recipient list.');
  }
  const state: AgentPolicyState = {
    status,
    id: data.slice(4, 36),
    owner: new PublicKey(data.slice(36, 68)),
    agent: new PublicKey(data.slice(68, 100)),
    mint: new PublicKey(data.slice(100, 132)),
    budget: amount(132),
    maxPayment: amount(140),
    spent: amount(148),
    expiresAt: time(156),
    createdAt: time(164),
    recipients,
  };
  if (state.budget === 0n || state.maxPayment === 0n || state.maxPayment > state.budget ||
      state.spent > state.budget || state.expiresAt <= state.createdAt) {
    throw new Error('Inconsistent agent-payments policy values.');
  }
  return state;
}

export function decodeAgentPaymentReceipt(data: Uint8Array): AgentPaymentReceipt {
  if (data.length !== AGENT_RECEIPT_SIZE || data[0] !== 1) {
    throw new Error('Invalid agent-payment receipt account.');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const amount = view.getBigUint64(98, true);
  const createdAt = Number(view.getBigInt64(106, true));
  if (amount === 0n || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('Malformed agent-payment receipt values.');
  }
  return {
    policy: new PublicKey(data.slice(2, 34)),
    paymentId: data.slice(34, 66),
    recipient: new PublicKey(data.slice(66, 98)),
    amount,
    createdAt,
  };
}

export function explainAgentPaymentError(text: string): string | null {
  const match = /custom program error: 0x([0-9a-f]+)|Custom\D{0,3}(\d+)/i.exec(text);
  if (!match) return null;
  const code = match[1] ? Number.parseInt(match[1], 16) : Number(match[2]);
  return AGENT_PAYMENT_ERRORS[code] ?? null;
}
