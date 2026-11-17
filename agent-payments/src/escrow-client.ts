import { Buffer } from 'buffer';
import {
  ComputeBudgetProgram, Message, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js';

export const ESCROW_STATE_SIZE = 202;
export const TOKEN_ACCOUNT_SIZE = 165;
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Lighthouse assertion program. Phantom appends its instructions; XMRVM installs a no-op shim here. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
export const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId;
/** Upper bound on a wallet-added priority fee, in lamports (internal, valueless compute credits). */
export const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 5_000_000n;
const WALLET_ADDED_PROGRAMS = [LIGHTHOUSE_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID];
export const ESCROW_STATUS = {
  active: 1,
  released: 2,
  refunded: 3,
} as const;

export type EscrowStatus = keyof typeof ESCROW_STATUS;
export type EscrowOutcome = 'release' | 'refund';

export interface EscrowState {
  status: EscrowStatus;
  id: Uint8Array;
  buyer: PublicKey;
  seller: PublicKey;
  arbiter: PublicKey;
  token: PublicKey;
  mint: PublicKey;
  amount: bigint;
}

function u64(value: bigint): Uint8Array {
  if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('Escrow amount must be between 1 and u64::MAX.');
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function parseXmrAmount(input: string): bigint {
  const value = input.trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,12}))?$/.exec(value);
  if (!match) throw new Error('Enter an XMR amount with up to 12 decimal places.');
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(12, '0') || '0');
  const amount = whole * 1_000_000_000_000n + fraction;
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) {
    throw new Error('Amount must be greater than zero and fit in the XMRVM token amount range.');
  }
  return amount;
}

export function formatXmrAmount(amount: bigint): string {
  const whole = amount / 1_000_000_000_000n;
  const fraction = (amount % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function deriveEscrowAddress(programId: PublicKey, id: Uint8Array): PublicKey {
  if (id.length !== 32) throw new Error('Escrow id must be exactly 32 bytes.');
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('escrow'), id], programId)[0];
}

export function deriveAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function createInitializeTokenAccountInstruction(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]),
  });
}

/** SPL Token `TransferChecked` (instruction 12): the mint and decimals are verified on-chain. */
export function createTransferCheckedInstruction(accounts: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  if (!Number.isInteger(accounts.decimals) || accounts.decimals < 0 || accounts.decimals > 255) {
    throw new RangeError('Invalid token decimals.');
  }
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64(accounts.amount), 1);
  data[9] = accounts.decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: accounts.source, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.destination, isSigner: false, isWritable: true },
      { pubkey: accounts.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function createInitializeEscrowInstruction(accounts: {
  programId: PublicKey;
  escrow: PublicKey;
  buyer: PublicKey;
  mint: PublicKey;
  buyerToken: PublicKey;
  escrowToken: PublicKey;
  seller: PublicKey;
  arbiter: PublicKey;
  id: Uint8Array;
  amount: bigint;
}): TransactionInstruction {
  if (accounts.id.length !== 32) throw new Error('Escrow id must be exactly 32 bytes.');
  const amount = u64(accounts.amount);
  const data = new Uint8Array(41);
  data[0] = 0;
  data.set(accounts.id, 1);
  data.set(amount, 33);
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.escrow, isSigner: false, isWritable: true },
      { pubkey: accounts.buyer, isSigner: true, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.buyerToken, isSigner: false, isWritable: true },
      { pubkey: accounts.escrowToken, isSigner: false, isWritable: true },
      { pubkey: accounts.seller, isSigner: false, isWritable: false },
      { pubkey: accounts.arbiter, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function createSettleEscrowInstruction(accounts: {
  programId: PublicKey;
  escrow: PublicKey;
  signer: PublicKey;
  escrowToken: PublicKey;
  destination: PublicKey;
  outcome: EscrowOutcome;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.escrow, isSigner: false, isWritable: true },
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.escrowToken, isSigner: false, isWritable: true },
      { pubkey: accounts.destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([accounts.outcome === 'release' ? 1 : 2]),
  });
}

export function decodeEscrowState(data: Uint8Array): EscrowState {
  if (data.length !== ESCROW_STATE_SIZE) throw new Error('Unexpected escrow state size.');
  const statusValue = data[0];
  const status = (Object.entries(ESCROW_STATUS).find(([, value]) => value === statusValue)?.[0]) as EscrowStatus | undefined;
  if (!status) throw new Error('Unknown escrow status.');
  const readKey = (offset: number) => new PublicKey(data.slice(offset, offset + 32));
  const amount = new DataView(data.buffer, data.byteOffset + 194, 8).getBigUint64(0, true);
  if (amount === 0n) throw new Error('Escrow state contains a zero amount.');
  return {
    status,
    id: data.slice(2, 34),
    buyer: readKey(34),
    seller: readKey(66),
    arbiter: readKey(98),
    token: readKey(130),
    mint: readKey(162),
    amount,
  };
}

export interface WalletChangeReport {
  /** Program IDs of instructions the wallet added; empty when the transaction is unchanged. */
  addedPrograms: PublicKey[];
  /** Worst-case priority fee the added compute-budget instructions can charge, in lamports. */
  priorityFeeLamports: bigint;
}

function signerKeys(message: Message): string[] {
  return message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
}

function sameInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  return a.programId.equals(b.programId) && Buffer.from(a.data).equals(Buffer.from(b.data)) &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, index) => key.pubkey.equals(b.keys[index]!.pubkey) && key.isSigner === b.keys[index]!.isSigner);
}

/**
 * Checks what a wallet changed between the message the dApp built and the message it signed.
 * Wallets such as Phantom append Lighthouse assertions and compute-budget instructions. Those
 * are accepted; anything else is refused: every built instruction must still be present,
 * unchanged and in order, with the same fee payer, blockhash and signers.
 */
export function verifyWalletChanges(built: Uint8Array, signed: Uint8Array): WalletChangeReport {
  const builtMessage = Message.from(Buffer.from(built));
  const signedMessage = Message.from(Buffer.from(signed));
  if (builtMessage.recentBlockhash !== signedMessage.recentBlockhash) {
    throw new Error('The wallet changed the transaction blockhash, so it was not submitted. No funds moved.');
  }
  const builtSigners = signerKeys(builtMessage);
  const signedSigners = signerKeys(signedMessage);
  if (builtSigners[0] !== signedSigners[0] ||
      builtSigners.length !== signedSigners.length || builtSigners.some((key) => !signedSigners.includes(key))) {
    throw new Error('The wallet changed who signs or pays for the transaction, so it was not submitted. No funds moved.');
  }
  const expected = Transaction.populate(builtMessage).instructions;
  const actual = Transaction.populate(signedMessage).instructions;
  const builtPrograms = new Set(expected.map((instruction) => instruction.programId.toBase58()));
  const addedPrograms: PublicKey[] = [];
  const unknown = new Set<string>();
  let altered = false;
  let limit: bigint | null = null;
  let microLamportsPerUnit = 0n;
  let matched = 0;
  for (const instruction of actual) {
    const next = expected[matched];
    if (next && sameInstruction(instruction, next)) {
      matched += 1;
      continue;
    }
    if (builtPrograms.has(instruction.programId.toBase58())) {
      altered = true;
      continue;
    }
    if (!WALLET_ADDED_PROGRAMS.some((program) => program.equals(instruction.programId))) {
      unknown.add(instruction.programId.toBase58());
      continue;
    }
    addedPrograms.push(instruction.programId);
    if (instruction.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
      const data = Buffer.from(instruction.data);
      if (data[0] === 2 && data.length >= 5) limit = BigInt(data.readUInt32LE(1));
      if (data[0] === 3 && data.length >= 9) microLamportsPerUnit = data.readBigUInt64LE(1);
    }
  }
  if (altered || matched !== expected.length) {
    throw new Error('The wallet removed or altered an instruction, so the transaction was not submitted. No funds moved.');
  }
  if (unknown.size > 0) {
    throw new Error(`The wallet added instructions for an unrecognised program (${[...unknown].join(', ')}), so the transaction was not submitted. No funds moved.`);
  }
  const programInstructions = BigInt(actual.filter((ix) => !ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).length);
  const units = limit ?? (programInstructions * 200_000n > 1_400_000n ? 1_400_000n : programInstructions * 200_000n);
  const priorityFeeLamports = (units * microLamportsPerUnit + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > MAX_WALLET_PRIORITY_FEE_LAMPORTS) {
    throw new Error('The wallet set an unusually high priority fee, so the transaction was not submitted. No funds moved.');
  }
  return { addedPrograms, priorityFeeLamports };
}
