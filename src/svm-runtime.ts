import { createHash, randomBytes } from 'node:crypto';
import {
  address, type Address, createKeyPairSignerFromBytes, generateKeyPairSigner, lamports, pipe,
  createTransactionMessage, setTransactionMessageFeePayerSigner, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, getTransactionDecoder, getTransactionEncoder,
  getCompiledTransactionMessageDecoder, decompileTransactionMessage, getBase58Decoder, getBase58Encoder,
  getBase64Decoder, getBase64Encoder, getPublicKeyFromAddress, verifySignature, type Instruction,
  type KeyPairSigner, type Transaction, type CompiledTransactionMessage, AccountRole,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS, getMintSize, getInitializeMint2Instruction, getMintToInstruction,
  getTransferInstruction, getBurnInstruction, getCreateAssociatedTokenIdempotentInstruction,
  findAssociatedTokenPda, getTokenDecoder, getMintDecoder, identifyTokenInstruction, TokenInstruction,
  parseTransferInstruction, parseTransferCheckedInstruction,
} from '@solana-program/token';
import { LiteSVM, FailedTransactionMetadata, type TransactionMetadata } from 'litesvm';
import { amount, InputError } from './errors.js';
import type { BridgeStatus, LedgerRuntime, MoneroNetwork, VerifiedMoneroWithdrawalView } from './ledger.js';
import type { MoneroDepositAddress, VerifiedMoneroDeposit, Withdrawal, WithdrawalState } from './ledger.js';
import { SnapshotStore } from './store.js';

/**
 * Solana VM ledger. XMR is an SPL mint with 12 decimals, so 1 token unit = 1 piconero and the
 * Monero bridge needs no scaling. Lamports are free internal compute/rent credits with no value.
 *
 * Withdrawal protocol (no custom program required): a transaction that transfers XMR tokens
 * to the reserve vault must carry exactly one Memo v1 instruction `xmrw:<monero address>:<fee budget>`.
 * principal = transferred amount - fee budget. The runtime validates this before execution.
 */

export const SVM_GENESIS_HASH = 'XMRVMstagenet1111111111111111111111111111111';
export const MEMO_V1_PROGRAM = address('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
export const XMR_DECIMALS = 12;
/** Lamports granted to a user on first deposit address and topped up on each credited deposit. */
const USER_LAMPORT_GRANT = 1_000_000_000n;
const USER_LAMPORT_FLOOR = 100_000_000n;
const AUTHORITY_LAMPORTS = 1_000_000_000_000n;
const MAX_TX_BYTES = 1232;
const SCHEMA = 'svm-1';

export interface SvmReceipt {
  signature: string;
  slot: number;
  blockTime: number;
  success: boolean;
  error: string | null;
  logs: string[];
  computeUnits: string;
  fee: string;
  raw: string;
  accounts: string[];
  withdrawalIds: string[];
  /** Pre/post lamport balances of the static accounts, for getTransaction meta. */
  preBalances: string[];
  postBalances: string[];
}

interface Snapshot {
  schema: typeof SCHEMA;
  authoritySecret: string;
  mint: string;
  vault: string;
  sequence: number;
  reserves: string;
  liabilities: string;
  pending: string;
  feeReserve: string;
  deposits: Record<string, {
    account: string; amount: string; source: 'monero-stagenet';
    txid: string; major: number; minor: number; height: number; confirmations: number;
  }>;
  depositAddresses: Record<string, MoneroDepositAddress>;
  moneroBridgeHalt?: string;
  withdrawals: Record<string, Withdrawal>;
  receipts: Record<string, SvmReceipt>;
  signatures: string[];
  programs: Record<string, string>;
  /** Total units minted by the simulation faucet; must be zero for a Monero-backed ledger. */
  faucetCredits?: string;
}

function b58(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

function pubkey(value: string): Address {
  try {
    return address(value);
  } catch {
    throw new InputError('INVALID_ADDRESS', 'Expected a base58 Solana public key');
  }
}

/**
 * The SVM reports a duplicate transaction signature as TransactionError::AlreadyProcessed,
 * which surfaces here either by name or as its variant index, "6".
 */
function alreadyProcessed(err: unknown): boolean {
  const text = String(err);
  return text.includes('AlreadyProcessed') || text === '6';
}

function checked(snapshot: Snapshot): void {
  const r = BigInt(snapshot.reserves);
  const l = BigInt(snapshot.liabilities);
  const w = BigInt(snapshot.pending);
  const f = BigInt(snapshot.feeReserve);
  if ([r, l, w, f].some((n) => n < 0n) || r !== l + w + f) {
    throw new Error('ACCOUNTING_INVARIANT: expected R = L + W + F');
  }
  let pending = 0n;
  let fees = 0n;
  for (const withdrawal of Object.values(snapshot.withdrawals)) {
    if (withdrawal.state !== 'SETTLED_POLICY' && withdrawal.state !== 'CANCELLED_PRE_SIGN') {
      pending += BigInt(withdrawal.principal);
      fees += BigInt(withdrawal.feeBudget);
    }
  }
  if (pending !== w || fees !== f) throw new Error('ACCOUNTING_INVARIANT: pending withdrawal totals differ');
}

export interface ParsedWithdrawalRequest {
  owner: string;
  destination: string;
  principal: bigint;
  feeBudget: bigint;
}

export class SvmRuntime implements LedgerRuntime {
  readonly unitsPerPiconero = 1n;
  private queue = Promise.resolve();
  private closed = false;
  private svm!: LiteSVM;
  private authority!: KeyPairSigner;
  private snapshot!: Snapshot;
  private revision = 0;
  private withdrawalsEnabled = true;

  private constructor(private readonly store: SnapshotStore) {}

  static async open(path: string, options: { withdrawalsEnabled?: boolean } = {}): Promise<SvmRuntime> {
    const store = new SnapshotStore(path);
    const runtime = new SvmRuntime(store);
    runtime.withdrawalsEnabled = options.withdrawalsEnabled ?? true;
    try {
      const saved = store.load();
      if (!saved) await runtime.genesis();
      else await runtime.restore(saved.json, saved.blob, saved.revision);
      return runtime;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  get mint(): Address { return address(this.snapshot.mint); }
  get vault(): Address { return address(this.snapshot.vault); }
  get authorityAddress(): Address { return this.authority.address; }

  private async genesis(): Promise<void> {
    this.svm = new LiteSVM().withTransactionHistory(10_000n);
    const seed = randomBytes(32);
    this.authority = await createKeyPairSignerFromBytes(await deriveKeyPairBytes(seed));
    const mint = await generateKeyPairSigner();
    this.svm.airdrop(this.authority.address, lamports(AUTHORITY_LAMPORTS));
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(getMintSize()));
    const [vault] = await findAssociatedTokenPda({
      mint: mint.address, owner: this.authority.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    await this.systemTransaction([
      getCreateAccountInstruction({
        payer: this.authority, newAccount: mint, lamports: rent, space: getMintSize(), programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: XMR_DECIMALS, mintAuthority: this.authority.address }),
      getCreateAssociatedTokenIdempotentInstruction({
        payer: this.authority, ata: vault, owner: this.authority.address, mint: mint.address,
      }),
    ]);
    this.snapshot = {
      schema: SCHEMA,
      authoritySecret: Buffer.from(seed).toString('base64'),
      mint: mint.address, vault, sequence: 0,
      reserves: '0', liabilities: '0', pending: '0', feeReserve: '0',
      deposits: {}, depositAddresses: {}, withdrawals: {}, receipts: {}, signatures: [], programs: {},
    };
    this.persist();
  }

  private async restore(json: string, blob: Uint8Array | null, revision: number): Promise<void> {
    const snapshot: Snapshot = JSON.parse(json);
    if (snapshot.schema !== SCHEMA) throw new Error('Incompatible database: not an SVM ledger');
    if (!blob) throw new Error('SVM ledger snapshot is missing its VM state');
    checked(snapshot);
    this.svm = LiteSVM.fromBytes(blob);
    const seed = Buffer.from(snapshot.authoritySecret, 'base64');
    if (seed.length !== 32) throw new Error('Invalid reserve authority seed');
    this.authority = await createKeyPairSignerFromBytes(await deriveKeyPairBytes(seed));
    this.snapshot = snapshot;
    this.revision = revision;
  }

  private persist(): void {
    checked(this.snapshot);
    this.revision = this.store.save(this.revision, JSON.stringify(this.snapshot), this.svm.toBytes());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Runtime is closed'));
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Runs `work` and persists; on failure the VM state is rolled back from the last snapshot. */
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const before = this.svm.toBytes();
      const json = JSON.stringify(this.snapshot);
      try {
        const result = await work();
        this.persist();
        return result;
      } catch (error) {
        this.svm = LiteSVM.fromBytes(before);
        this.snapshot = JSON.parse(json);
        throw error;
      }
    });
  }

  private async systemTransaction(instructions: Instruction[]): Promise<TransactionMetadata> {
    const build = async (): Promise<Transaction> => pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.authority, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => signTransactionMessageWithSigners(m),
    );
    let result = this.svm.sendTransaction(await build());
    // Authority-signed maintenance transactions carry no nonce, so two identical ones (same
    // owner and amount) compile to the same signature and are rejected as AlreadyProcessed.
    // Expire the blockhash and rebuild once so the retry is distinct. Only this failure path
    // touches the shared blockhash, leaving user transactions unaffected otherwise.
    // The runtime reports this as TransactionError variant 6, which stringifies to "6".
    if (result instanceof FailedTransactionMetadata && alreadyProcessed(result.err())) {
      this.svm.expireBlockhash();
      result = this.svm.sendTransaction(await build());
    }
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`System transaction failed: ${result.err()}`);
    }
    return result;
  }

  // ---- LedgerRuntime: identity -------------------------------------------------------------

  normalizeAccount(account: string): string {
    return pubkey(account);
  }

  depositAddressMessage(account: string, network: MoneroNetwork = 'stagenet'): string {
    return [
      `XMRVM ${network === 'mainnet' ? 'Mainnet' : 'Stagenet'} deposit address`,
      `Genesis: ${SVM_GENESIS_HASH}`,
      `Network: ${network}`,
      `Account: ${pubkey(account)}`,
      "Purpose: create or retrieve this account's deposit address.",
      'This signature does not authorize transactions or withdrawals.',
    ].join('\n');
  }

  async verifyAccountSignature(account: string, message: string, signature: string): Promise<boolean> {
    try {
      let bytes: Uint8Array;
      if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) bytes = new Uint8Array(getBase58Encoder().encode(signature));
      else if (/^0x[0-9a-fA-F]{128}$/.test(signature)) bytes = Buffer.from(signature.slice(2), 'hex');
      else bytes = new Uint8Array(getBase64Encoder().encode(signature));
      if (bytes.length !== 64) return false;
      const key = await getPublicKeyFromAddress(pubkey(account));
      return await verifySignature(key, bytes as Parameters<typeof verifySignature>[1], new TextEncoder().encode(message));
    } catch {
      return false;
    }
  }

  // ---- Queries ----------------------------------------------------------------------------

  async info() {
    return this.serial(async () => ({
      mode: 'LOCAL_SIMULATION_ONLY',
      vm: 'svm',
      teeAttested: false,
      moneroConfigured: false,
      confidential: false,
      genesisHash: SVM_GENESIS_HASH,
      mint: this.snapshot.mint,
      vault: this.snapshot.vault,
      authority: this.authority.address,
      memoProgram: MEMO_V1_PROGRAM,
      decimals: XMR_DECIMALS,
      unit: '1 token unit = 1 piconero (1e-12 XMR); lamports are free internal credits',
      sequence: this.snapshot.sequence,
      revision: this.revision,
      blockhash: this.svm.latestBlockhash(),
      accounting: {
        R: this.snapshot.reserves, L: this.snapshot.liabilities, W: this.snapshot.pending, F: this.snapshot.feeReserve,
      },
      withdrawalCount: Object.keys(this.snapshot.withdrawals).length,
    }));
  }

  async account(account: string) {
    const target = pubkey(account);
    return this.serial(async () => {
      const [ata] = await findAssociatedTokenPda({ mint: this.mint, owner: target, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const token = this.svm.getAccount(ata);
      const balance = token?.exists && token.data.length >= 72 ? getTokenDecoder().decode(token.data).amount : 0n;
      return {
        address: target, tokenAccount: ata, balance: balance.toString(),
        lamports: (this.svm.getBalance(target) ?? 0n).toString(),
      };
    });
  }

  /** Raw access for the Solana JSON-RPC layer; reads are served from the live VM. */
  async read<T>(work: (svm: LiteSVM, snapshot: Readonly<Snapshot>) => T): Promise<T> {
    return this.serial(async () => work(this.svm, this.snapshot));
  }

  async receipt(signature: string): Promise<SvmReceipt | null> {
    return this.serial(async () => this.snapshot.receipts[signature] ?? null);
  }

  async withdrawal(id: string): Promise<Withdrawal | null> {
    return this.serial(async () => this.snapshot.withdrawals[id] ?? null);
  }

  // ---- Transactions -----------------------------------------------------------------------

  /** Parses a wire transaction and extracts the withdrawal request it carries, if any. */
  parseWithdrawalRequest(compiled: CompiledTransactionMessage): ParsedWithdrawalRequest | null {
    const lookups = (compiled as { addressTableLookups?: unknown[] }).addressTableLookups;
    if (lookups && lookups.length > 0) {
      throw new InputError('UNSUPPORTED_TRANSACTION', 'Address lookup tables are not supported');
    }
    const message = decompileTransactionMessage(compiled as Parameters<typeof decompileTransactionMessage>[0]);
    const vaultTransfers: Array<{ owner: string; amount: bigint }> = [];
    const memos: string[] = [];
    for (const instruction of message.instructions) {
      if (instruction.programAddress === MEMO_V1_PROGRAM) {
        memos.push(new TextDecoder().decode(instruction.data ?? new Uint8Array()));
        continue;
      }
      if (instruction.programAddress !== TOKEN_PROGRAM_ADDRESS || !instruction.data || !instruction.accounts) continue;
      const kind = identifyTokenInstruction(instruction.data);
      if (kind === TokenInstruction.Transfer) {
        const parsed = parseTransferInstruction(instruction as Parameters<typeof parseTransferInstruction>[0]);
        if (parsed.accounts.destination.address === this.vault) {
          vaultTransfers.push({ owner: parsed.accounts.authority.address, amount: parsed.data.amount });
        }
      } else if (kind === TokenInstruction.TransferChecked) {
        const parsed = parseTransferCheckedInstruction(instruction as Parameters<typeof parseTransferCheckedInstruction>[0]);
        if (parsed.accounts.destination.address === this.vault) {
          vaultTransfers.push({ owner: parsed.accounts.authority.address, amount: parsed.data.amount });
        }
      }
    }
    if (vaultTransfers.length === 0) {
      if (memos.some((memo) => memo.startsWith('xmrw:'))) {
        throw new InputError('INVALID_WITHDRAWAL', 'Withdrawal memo without a transfer to the reserve vault');
      }
      return null;
    }
    if (vaultTransfers.length !== 1 || memos.length !== 1) {
      throw new InputError('INVALID_WITHDRAWAL', 'A withdrawal needs exactly one vault transfer and one memo');
    }
    const match = /^xmrw:([1-9A-HJ-NP-Za-km-z]{95}|[1-9A-HJ-NP-Za-km-z]{106}|test:[a-zA-Z0-9:_-]{1,90}):(0|[1-9][0-9]{0,18})$/.exec(memos[0]!);
    if (!match) throw new InputError('INVALID_WITHDRAWAL', 'Memo must be xmrw:<monero address>:<fee budget in piconero>');
    const feeBudget = BigInt(match[2]!);
    const transfer = vaultTransfers[0]!;
    if (transfer.amount <= feeBudget) throw new InputError('INVALID_WITHDRAWAL', 'Transfer must exceed the fee budget');
    return { owner: transfer.owner, destination: match[1]!, principal: transfer.amount - feeBudget, feeBudget };
  }

  async submit(wire: string | Uint8Array): Promise<SvmReceipt> {
    let bytes: Uint8Array;
    try {
      bytes = typeof wire === 'string' ? new Uint8Array(getBase64Encoder().encode(wire)) : wire;
    } catch {
      throw new InputError('INVALID_TRANSACTION', 'Expected a base64 encoded transaction');
    }
    if (bytes.length === 0 || bytes.length > MAX_TX_BYTES) {
      throw new InputError('INVALID_TRANSACTION', `Transaction must be 1..${MAX_TX_BYTES} bytes`);
    }
    let transaction: Transaction;
    let compiled: CompiledTransactionMessage;
    try {
      transaction = getTransactionDecoder().decode(bytes);
      compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    } catch {
      throw new InputError('INVALID_TRANSACTION', 'Transaction could not be decoded');
    }
    const signatureBytes = Object.values(transaction.signatures)[0];
    if (!signatureBytes) throw new InputError('INVALID_TRANSACTION', 'Transaction is unsigned');
    const signature = b58(signatureBytes);
    const request = this.parseWithdrawalRequest(compiled);
    if (request && !this.withdrawalsEnabled) {
      throw new InputError('WITHDRAWALS_DISABLED', 'Withdrawals are disabled in deposit-only mode', 403);
    }

    return this.mutate(async () => {
      const existing = this.snapshot.receipts[signature];
      if (existing) return existing;
      if (request && this.snapshot.moneroBridgeHalt) {
        throw new InputError('MONERO_BRIDGE_PAUSED', 'Withdrawals are paused for reconciliation', 503);
      }
      const accounts = compiled.staticAccounts.map(String);
      const preBalances = accounts.map((a) => (this.svm.getBalance(address(a)) ?? 0n).toString());
      const result = this.svm.sendTransaction(transaction);
      const failed = result instanceof FailedTransactionMetadata;
      const meta = failed ? result.meta() : result;
      const err = failed ? result.err() : null;
      if (failed && (String(err).includes('AlreadyProcessed') || String(err).includes('BlockhashNotFound') ||
          String(err).includes('SignatureFailure') || String(err).includes('AccountNotFound') && meta.computeUnitsConsumed() === 0n)) {
        throw new InputError('TRANSACTION_REJECTED', `Transaction rejected: ${String(err)}`, 400);
      }
      this.snapshot.sequence += 1;
      this.svm.warpToSlot(BigInt(this.snapshot.sequence));
      const receipt: SvmReceipt = {
        signature,
        slot: this.snapshot.sequence,
        blockTime: Math.floor(Date.now() / 1000),
        success: !failed,
        error: failed ? String(err) : null,
        logs: meta.logs(),
        computeUnits: meta.computeUnitsConsumed().toString(),
        fee: '5000',
        raw: getBase64Decoder().decode(bytes),
        accounts,
        withdrawalIds: [],
        preBalances,
        postBalances: accounts.map((a) => (this.svm.getBalance(address(a)) ?? 0n).toString()),
      };
      if (!failed && request) {
        const id = String(Object.keys(this.snapshot.withdrawals).length + 1);
        const total = request.principal + request.feeBudget;
        this.snapshot.liabilities = (BigInt(this.snapshot.liabilities) - total).toString();
        this.snapshot.pending = (BigInt(this.snapshot.pending) + request.principal).toString();
        this.snapshot.feeReserve = (BigInt(this.snapshot.feeReserve) + request.feeBudget).toString();
        this.snapshot.withdrawals[id] = {
          id, owner: request.owner, destination: request.destination,
          principal: request.principal.toString(), feeBudget: request.feeBudget.toString(),
          state: 'RESERVED', artifact: null, actualFee: null, transactionHash: signature,
          moneroTxHash: null, signedTxBlob: null,
        };
        receipt.withdrawalIds.push(id);
      }
      this.snapshot.receipts[signature] = receipt;
      this.snapshot.signatures.push(signature);
      return receipt;
    });
  }

  async simulate(wire: string) {
    let transaction: Transaction;
    try {
      transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    } catch {
      throw new InputError('INVALID_TRANSACTION', 'Transaction could not be decoded');
    }
    return this.serial(async () => {
      const result = this.svm.simulateTransaction(transaction);
      if (result instanceof FailedTransactionMetadata) {
        return { success: false, error: String(result.err()), logs: result.meta().logs(), computeUnits: result.meta().computeUnitsConsumed().toString() };
      }
      const meta = result.meta();
      return { success: true, error: null, logs: meta.logs(), computeUnits: meta.computeUnitsConsumed().toString() };
    });
  }

  /** Loads a compiled SBF program (developer deployment path for the private SVM). */
  async deployProgram(programId: string, elfBase64: string): Promise<{ programId: string; bytes: number }> {
    const id = pubkey(programId);
    const bytes = Buffer.from(elfBase64, 'base64');
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new InputError('INVALID_PROGRAM', 'Program must be 1 byte..10 MiB');
    return this.mutate(async () => {
      if (this.snapshot.programs[id]) throw new InputError('PROGRAM_EXISTS', 'Program ID is already deployed', 409);
      this.svm.addProgram(id, bytes);
      this.snapshot.programs[id] = createHash('sha256').update(bytes).digest('hex');
      return { programId: id, bytes: bytes.length };
    });
  }

  /** Simulation-only faucet: mints XMR units to an account. Disabled in bridge mode by the server. */
  async deposit(id: string, account: string, value: string) {
    const target = pubkey(account);
    const credit = amount(value);
    return this.mutate(async () => {
      await this.mintTo(target, credit);
      this.snapshot.reserves = (BigInt(this.snapshot.reserves) + credit).toString();
      this.snapshot.liabilities = (BigInt(this.snapshot.liabilities) + credit).toString();
      this.snapshot.faucetCredits = (BigInt(this.snapshot.faucetCredits ?? '0') + credit).toString();
      return { id, account: target, amount: value, replay: false, simulated: true };
    });
  }

  private async mintTo(owner: Address, units: bigint): Promise<void> {
    const [ata] = await findAssociatedTokenPda({ mint: this.mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const instructions: Instruction[] = [
      getCreateAssociatedTokenIdempotentInstruction({ payer: this.authority, ata, owner, mint: this.mint }),
      getMintToInstruction({ mint: this.mint, token: ata, mintAuthority: this.authority, amount: units }),
    ];
    await this.systemTransaction(instructions);
    if ((this.svm.getBalance(owner) ?? 0n) < USER_LAMPORT_FLOOR) this.svm.airdrop(owner, lamports(USER_LAMPORT_GRANT));
  }

  private async vaultTo(owner: Address, units: bigint): Promise<void> {
    if (units === 0n) return;
    const [ata] = await findAssociatedTokenPda({ mint: this.mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await this.systemTransaction([
      getCreateAssociatedTokenIdempotentInstruction({ payer: this.authority, ata, owner, mint: this.mint }),
      getTransferInstruction({ source: this.vault, destination: ata, authority: this.authority, amount: units }),
    ]);
  }

  private async burnFromVault(units: bigint): Promise<void> {
    if (units === 0n) return;
    await this.systemTransaction([
      getBurnInstruction({ account: this.vault, mint: this.mint, authority: this.authority, amount: units }),
    ]);
  }

  // ---- LedgerRuntime: deposits ------------------------------------------------------------

  async depositAddress(account: string, create: () => Promise<Omit<MoneroDepositAddress, 'account'>>): Promise<MoneroDepositAddress> {
    const target = pubkey(account);
    return this.mutate(async () => {
      const existing = this.snapshot.depositAddresses[target];
      if (existing) return existing;
      const created = await create();
      if (!created.address || created.major !== 0 || !Number.isSafeInteger(created.minor) || created.minor < 0) {
        throw new Error('Wallet returned an invalid Stagenet subaddress');
      }
      if (Object.values(this.snapshot.depositAddresses).some((e) => e.major === created.major && e.minor === created.minor)) {
        throw new Error('Monero subaddress is already assigned to another account');
      }
      const assigned = { account: target, ...created };
      this.snapshot.depositAddresses[target] = assigned;
      if ((this.svm.getBalance(target) ?? 0n) < USER_LAMPORT_FLOOR) this.svm.airdrop(target, lamports(USER_LAMPORT_GRANT));
      return assigned;
    });
  }

  async depositAddresses(): Promise<MoneroDepositAddress[]> {
    return this.serial(async () => Object.values(this.snapshot.depositAddresses));
  }

  async moneroDeposits() {
    return this.serial(async () => Object.entries(this.snapshot.deposits).map(([id, d]) => ({ id, ...d })));
  }

  async creditMoneroDeposit(deposit: VerifiedMoneroDeposit) {
    if (!/^[a-f0-9]{64}$/.test(deposit.txid) || deposit.major !== 0 ||
        !Number.isSafeInteger(deposit.minor) || deposit.minor < 0 ||
        !Number.isSafeInteger(deposit.height) || deposit.height < 1 ||
        !Number.isSafeInteger(deposit.confirmations) || deposit.confirmations < 1) {
      throw new InputError('INVALID_MONERO_DEPOSIT', 'Invalid verified Stagenet transfer identity');
    }
    const target = pubkey(deposit.account);
    const credit = amount(deposit.amount);
    const id = `xmr-${deposit.txid}-${deposit.major}-${deposit.minor}`;
    return this.mutate(async () => {
      const existing = this.snapshot.deposits[id];
      if (existing) {
        if (existing.account !== target || existing.amount !== deposit.amount ||
            existing.txid !== deposit.txid || existing.major !== deposit.major ||
            existing.minor !== deposit.minor) {
          throw new InputError('DEPOSIT_ID_CONFLICT', 'Monero transfer identity conflicts with prior accounting', 409);
        }
        return { id, account: target, amount: deposit.amount, replay: true, simulated: false };
      }
      if (this.snapshot.moneroBridgeHalt) {
        throw new InputError('MONERO_BRIDGE_PAUSED', 'Monero accounting is paused for reconciliation', 503);
      }
      const assigned = this.snapshot.depositAddresses[target];
      if (!assigned || assigned.major !== deposit.major || assigned.minor !== deposit.minor) {
        throw new InputError('DEPOSIT_ATTRIBUTION', 'Monero transfer is not assigned to this account', 409);
      }
      await this.mintTo(target, credit);
      this.snapshot.reserves = (BigInt(this.snapshot.reserves) + credit).toString();
      this.snapshot.liabilities = (BigInt(this.snapshot.liabilities) + credit).toString();
      this.snapshot.deposits[id] = {
        account: target, amount: deposit.amount, source: 'monero-stagenet',
        txid: deposit.txid, major: deposit.major, minor: deposit.minor,
        height: deposit.height, confirmations: deposit.confirmations,
      };
      return { id, account: target, amount: deposit.amount, replay: false, simulated: false };
    });
  }

  // ---- LedgerRuntime: bridge state --------------------------------------------------------

  async moneroBridgeStatus(): Promise<BridgeStatus> {
    return this.serial(async () => ({
      state: this.snapshot.moneroBridgeHalt ? 'RECONCILIATION_REQUIRED' as const : 'ACTIVE' as const,
      reason: this.snapshot.moneroBridgeHalt ?? null,
    }));
  }

  async haltMoneroBridge(reason: string): Promise<BridgeStatus> {
    if (!/^[A-Z0-9_]{1,64}$/.test(reason)) throw new Error('Invalid Monero bridge halt reason');
    return this.mutate(async () => {
      this.snapshot.moneroBridgeHalt ??= reason;
      return { state: 'RECONCILIATION_REQUIRED' as const, reason: this.snapshot.moneroBridgeHalt };
    });
  }

  async resumeMoneroBridgeAfterVerifiedWithdrawal(id: string, transfer: VerifiedMoneroWithdrawalView): Promise<void> {
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      if (withdrawal.state !== 'SUBMITTED' ||
          this.snapshot.moneroBridgeHalt !== 'WITHDRAWAL_CHAIN_VIEW_UNAVAILABLE' ||
          withdrawal.moneroTxHash !== transfer.txid ||
          BigInt(withdrawal.principal) !== BigInt(transfer.amount) ||
          BigInt(withdrawal.actualFee ?? '-1') !== BigInt(transfer.fee) ||
          !['out', 'pending'].includes(transfer.type) || transfer.doubleSpendSeen) {
        throw new InputError('MONERO_RECONCILIATION_REQUIRED',
          'Verified wallet transfer does not match the submitted payout', 503);
      }
      delete this.snapshot.moneroBridgeHalt;
    });
  }

  async assertStagenetLedger(): Promise<void> {
    return this.serial(async () => {
      if (BigInt(this.snapshot.faucetCredits ?? '0') > 0n) {
        throw new InputError('SIMULATION_LEDGER_NOT_ALLOWED', 'Ledger contains simulated faucet deposits', 409);
      }
      if (Object.values(this.snapshot.withdrawals).some((w) => w.artifact?.startsWith('test-artifact:'))) {
        throw new InputError('SIMULATION_LEDGER_NOT_ALLOWED', 'Ledger contains simulated withdrawals', 409);
      }
      const supply = this.svm.getAccount(this.mint);
      const minted = supply?.exists ? getMintDecoder().decode(supply.data).supply : 0n;
      if (minted !== BigInt(this.snapshot.liabilities) + BigInt(this.snapshot.pending) + BigInt(this.snapshot.feeReserve)) {
        throw new InputError('SIMULATION_LEDGER_NOT_ALLOWED', 'Token supply does not match Monero-backed accounting', 409);
      }
    });
  }

  // ---- LedgerRuntime: withdrawals ---------------------------------------------------------

  private requireWithdrawal(id: string): Withdrawal {
    const withdrawal = this.snapshot.withdrawals[id];
    if (!withdrawal) throw new InputError('NOT_FOUND', 'Withdrawal not found', 404);
    return withdrawal;
  }

  async pendingWithdrawals(): Promise<Withdrawal[]> {
    return this.serial(async () => Object.values(this.snapshot.withdrawals)
      .filter((w) => w.state !== 'CANCELLED_PRE_SIGN' && (w.state !== 'SETTLED_POLICY' || typeof w.moneroTxHash === 'string')));
  }

  async beginMoneroWithdrawal(id: string): Promise<Withdrawal> {
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      if (withdrawal.state !== 'RESERVED') throw new InputError('INVALID_TRANSITION', 'Only a reserved withdrawal can begin signing', 409);
      withdrawal.state = 'SIGNING';
      return withdrawal;
    });
  }

  async cancelMoneroWithdrawalAfterDefinitiveSigningFailure(id: string): Promise<Withdrawal> {
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      if (withdrawal.state !== 'SIGNING' || withdrawal.artifact !== null ||
          withdrawal.actualFee !== null || withdrawal.moneroTxHash != null || withdrawal.signedTxBlob != null) {
        throw new InputError('INVALID_TRANSITION', 'Only a definitively rejected unsigned payout can be refunded', 409);
      }
      const principal = BigInt(withdrawal.principal);
      const budget = BigInt(withdrawal.feeBudget);
      await this.vaultTo(address(withdrawal.owner), principal + budget);
      this.snapshot.liabilities = (BigInt(this.snapshot.liabilities) + principal + budget).toString();
      this.snapshot.pending = (BigInt(this.snapshot.pending) - principal).toString();
      this.snapshot.feeReserve = (BigInt(this.snapshot.feeReserve) - budget).toString();
      withdrawal.state = 'CANCELLED_PRE_SIGN';
      const hasUncertainWithdrawal = Object.values(this.snapshot.withdrawals).some((entry) =>
        entry.id !== id && ['SIGNING', 'SIGNED', 'SUBMISSION_UNKNOWN', 'SUBMITTED', 'PAUSED_RECONCILIATION'].includes(entry.state));
      if (this.snapshot.moneroBridgeHalt === 'WITHDRAWAL_SIGNING_OUTCOME_UNKNOWN' && !hasUncertainWithdrawal) {
        delete this.snapshot.moneroBridgeHalt;
      }
      return withdrawal;
    });
  }

  async recordMoneroWithdrawalSignature(id: string, txHash: string, txBlob: string, fee: string): Promise<Withdrawal> {
    if (!/^[a-f0-9]{64}$/.test(txHash) || !/^(?:[a-f0-9]{2})+$/.test(txBlob)) {
      throw new InputError('INVALID_MONERO_ARTIFACT', 'Wallet returned an invalid signed Stagenet transaction');
    }
    const actualFee = amount(fee, 'actualFee', true);
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      if (withdrawal.state !== 'SIGNING') throw new InputError('INVALID_TRANSITION', 'Withdrawal is not awaiting a Stagenet signature', 409);
      withdrawal.moneroTxHash = txHash;
      withdrawal.signedTxBlob = txBlob;
      withdrawal.artifact = `stagenet:${txHash}`;
      withdrawal.actualFee = actualFee.toString();
      withdrawal.state = actualFee > BigInt(withdrawal.feeBudget) ? 'PAUSED_RECONCILIATION' : 'SIGNED';
      return withdrawal;
    });
  }

  async markMoneroWithdrawalUnknown(id: string): Promise<Withdrawal> {
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      if (!['SIGNED', 'SUBMISSION_UNKNOWN'].includes(withdrawal.state)) {
        throw new InputError('INVALID_TRANSITION', 'Withdrawal has no recoverable signed transaction', 409);
      }
      withdrawal.state = 'SUBMISSION_UNKNOWN';
      return withdrawal;
    });
  }

  async markMoneroWithdrawalSubmitted(id: string, txHash: string): Promise<Withdrawal> {
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      if (withdrawal.moneroTxHash !== txHash || !['SIGNED', 'SUBMISSION_UNKNOWN', 'SUBMITTED'].includes(withdrawal.state)) {
        throw new InputError('MONERO_TX_MISMATCH', 'Submission does not match the authorized signed transaction', 409);
      }
      withdrawal.state = 'SUBMITTED';
      return withdrawal;
    });
  }

  async transitionWithdrawal(id: string, action: string, value?: string): Promise<Withdrawal> {
    return this.mutate(async () => {
      const withdrawal = this.requireWithdrawal(id);
      const principal = BigInt(withdrawal.principal);
      const budget = BigInt(withdrawal.feeBudget);
      const owner = address(withdrawal.owner);
      if (action === 'cancel') {
        if (withdrawal.state === 'CANCELLED_PRE_SIGN') return withdrawal;
        if (withdrawal.state !== 'RESERVED') {
          throw new InputError('SIGNED_PAYOUT_LOCKED', 'A potentially valid signed payout cannot be cancelled or refunded', 409);
        }
        await this.vaultTo(owner, principal + budget);
        this.snapshot.liabilities = (BigInt(this.snapshot.liabilities) + principal + budget).toString();
        this.snapshot.pending = (BigInt(this.snapshot.pending) - principal).toString();
        this.snapshot.feeReserve = (BigInt(this.snapshot.feeReserve) - budget).toString();
        withdrawal.state = 'CANCELLED_PRE_SIGN';
      } else if (action === 'settle') {
        const fee = amount(value, 'actualFee', true);
        if (withdrawal.state === 'SETTLED_POLICY' && withdrawal.actualFee === value) return withdrawal;
        if (!['SIGNED', 'SUBMISSION_UNKNOWN', 'SUBMITTED'].includes(withdrawal.state)) {
          throw new InputError('INVALID_TRANSITION', 'Cannot settle an unsigned or terminal withdrawal', 409);
        }
        if (fee > budget) throw new InputError('FEE_EXCEEDED', 'Actual fee exceeds the locked fee budget');
        await this.burnFromVault(principal + fee);
        await this.vaultTo(owner, budget - fee);
        this.snapshot.reserves = (BigInt(this.snapshot.reserves) - principal - fee).toString();
        this.snapshot.liabilities = (BigInt(this.snapshot.liabilities) + budget - fee).toString();
        this.snapshot.pending = (BigInt(this.snapshot.pending) - principal).toString();
        this.snapshot.feeReserve = (BigInt(this.snapshot.feeReserve) - budget).toString();
        withdrawal.state = 'SETTLED_POLICY';
        withdrawal.actualFee = fee.toString();
      } else if (action === 'sign' || action === 'unknown' || action === 'submit') {
        // Test-harness transitions mirror the EVM runtime so shared tests can drive both ledgers.
        if (action === 'sign') {
          if (withdrawal.state !== 'RESERVED') throw new InputError('INVALID_TRANSITION', 'Only a reserved withdrawal can be simulated as signed', 409);
          withdrawal.artifact = `test-artifact:${value ?? ''}`;
          withdrawal.state = 'SIGNED';
        } else {
          const next: WithdrawalState = action === 'unknown' ? 'SUBMISSION_UNKNOWN' : 'SUBMITTED';
          if (!['SIGNED', 'SUBMISSION_UNKNOWN', next].includes(withdrawal.state)) {
            throw new InputError('INVALID_TRANSITION', 'Expected an existing signed artifact', 409);
          }
          withdrawal.state = next;
        }
      } else {
        throw new InputError('INVALID_ACTION', 'Expected cancel, settle, sign, unknown or submit');
      }
      return withdrawal;
    });
  }

  async close(): Promise<void> {
    await this.serial(async () => { this.closed = true; });
    this.store.close();
  }
}

/** Builds the 64-byte (seed || public key) form @solana/kit expects from an Ed25519 seed. */
async function deriveKeyPairBytes(seed: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (!jwk.x) throw new Error('Ed25519 key export failed');
  const publicKey = Buffer.from(jwk.x, 'base64url');
  return new Uint8Array(Buffer.concat([seed, publicKey]));
}
