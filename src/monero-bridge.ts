import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LedgerRuntime, MoneroNetwork, MoneroDepositAddress, VerifiedMoneroWithdrawalView } from './ledger.js';
import { InputError } from './errors.js';
import {
  walletRequest, WalletRpcError, type WalletCredentials, type WalletMethod, parseRpcJson, rpcRecord,
} from './monero-wallet.js';

const DEFAULT_CONFIRMATIONS = 10;
/** EVM ledger scale: 1 XMR = 1e12 piconero = 1e18 units, so 1 piconero = 1e6 units. */
export const UNITS_PER_PICONERO = 1_000_000n;
const MAX_WALLET_LAG_BLOCKS = 3;

export function piconeroToUnits(piconero: string, scale: bigint = UNITS_PER_PICONERO): string {
  return (BigInt(piconero) * scale).toString();
}

export function unitsToPiconero(units: string, scale: bigint = UNITS_PER_PICONERO): string {
  const value = BigInt(units);
  if (value % scale !== 0n) throw new Error('Amount is not a whole number of piconero');
  return (value / scale).toString();
}

export interface MoneroWalletClient {
  request(method: WalletMethod, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface MoneroDaemonClient {
  info(): Promise<Record<string, unknown>>;
  relay(txBlob: string): Promise<Record<string, unknown>>;
}

export interface MoneroBridgeOptions {
  confirmations?: number;
  network?: MoneroNetwork;
  withdrawalsEnabled?: boolean;
}

export function depositAddressMessage(account: string, network: MoneroNetwork = 'stagenet'): string {
  return [
    `XMRVM ${network === 'mainnet' ? 'Mainnet' : 'Stagenet'} deposit address`,
    `Network: ${network}`,
    `Account: ${account}`,
    "Purpose: create or retrieve this account's deposit address.",
    'This signature does not authorize transactions or withdrawals.',
  ].join('\n');
}

function integer(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Wallet returned an invalid ${field}`);
  }
  return parsed;
}

function decimal(value: unknown): string {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('Wallet returned an invalid atomic amount');
}

function endpoint(url: URL, path: string, body: string): Promise<Record<string, unknown>> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error('Monero daemon response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('Monero daemon RPC failed'));
          return;
        }
        try {
          resolve(rpcRecord(parseRpcJson(Buffer.concat(chunks).toString('utf8'))));
        } catch {
          reject(new Error('Monero daemon returned an invalid response'));
        }
      });
      response.on('error', () => reject(new Error('Monero daemon response failed')));
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Monero daemon RPC timed out')));
    req.on('error', (error: Error) => {
      reject(error.message === 'Monero daemon RPC timed out' ||
        error.message === 'Monero daemon response exceeded the size limit'
        ? error
        : new Error('Monero daemon is unavailable'));
    });
    req.end(body);
  });
}

export function moneroDaemon(address: string): MoneroDaemonClient {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('Invalid Monero daemon URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Monero daemon URL must be http(s)://host:port without credentials or path');
  }
  return {
    async info() {
      return endpoint(url, '/get_info', '{}');
    },
    async relay(txBlob) {
      if (!/^(?:[a-f0-9]{2})+$/.test(txBlob)) throw new Error('Invalid signed Monero transaction');
      return endpoint(url, '/sendrawtransaction', JSON.stringify({
        tx_as_hex: txBlob,
        do_sanity_checks: true,
      }));
    },
  };
}

export function localMoneroDaemon(port = 38081): MoneroDaemonClient {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid daemon RPC port');
  return moneroDaemon(`http://127.0.0.1:${port}`);
}

export function localMoneroWallet(
  credentials: WalletCredentials,
  port = 38088,
): MoneroWalletClient {
  return {
    request: (method, params = {}) => walletRequest(credentials, method, params, port),
  };
}

export class MoneroBridge {
  private scanning = false;
  private lastScan: string | null = null;
  private readonly scale: bigint;
  private constructor(
    private readonly runtime: LedgerRuntime,
    private readonly wallet: MoneroWalletClient,
    private readonly daemon: MoneroDaemonClient,
    private readonly confirmations: number,
    private readonly network: MoneroNetwork,
    private readonly withdrawalsEnabled: boolean,
  ) {
    this.scale = runtime.unitsPerPiconero;
  }

  static create(
    runtime: LedgerRuntime,
    wallet: MoneroWalletClient,
    daemon: MoneroDaemonClient,
    options: MoneroBridgeOptions = {},
  ): MoneroBridge {
    const confirmations = options.confirmations ?? DEFAULT_CONFIRMATIONS;
    if (!Number.isSafeInteger(confirmations) || confirmations < 10 || confirmations > 1000) {
      throw new Error('Monero deposit confirmations must be between 10 and 1000');
    }
    const network = options.network ?? 'stagenet';
    return new MoneroBridge(runtime, wallet, daemon, confirmations, network, options.withdrawalsEnabled ?? true);
  }

  async verifyNetwork(requireSynchronized = true): Promise<Record<string, unknown>> {
    const info = await this.daemon.info();
    if (info.status !== 'OK' || info.nettype !== this.network) {
      const networkName = this.network === 'mainnet' ? 'Mainnet' : 'Stagenet';
      throw new Error(`The configured Monero daemon is not ${networkName}`);
    }
    if (requireSynchronized && info.synchronized !== true) {
      throw new InputError('MONERO_NODE_NOT_SYNCED', 'Monero node is not synchronized', 503);
    }
    await this.wallet.request('get_version');
    const address = await this.wallet.request('get_address', { account_index: 0 });
    if (typeof address.address !== 'string') throw new Error('Monero reserve wallet is not open');
    const validation = await this.wallet.request('validate_address', {
      address: address.address,
      any_net_type: false,
      allow_openalias: false,
    });
    if (validation.valid !== true || validation.nettype !== this.network) {
      throw new Error(`Reserve wallet is not configured for ${this.network}`);
    }
    return info;
  }

  /** Kept for callers that still use the previous names. */
  verifyStagenet(requireSynchronized = true): Promise<Record<string, unknown>> {
    return this.verifyNetwork(requireSynchronized);
  }

  verifyLocalStagenet(requireSynchronized = true): Promise<Record<string, unknown>> {
    return this.verifyNetwork(requireSynchronized);
  }

  depositAddressMessage(account: string): string {
    const signer = this.runtime.normalizeAccount(account);
    return this.runtime.depositAddressMessage(signer, this.network);
  }

  /** Opens an existing wallet or restores Mainnet from the encrypted provisioning seed. */
  async ensureReserveWallet(
    credentials: Pick<WalletCredentials, 'filename' | 'walletPassword' | 'seed' | 'restoreHeight'>,
    allowCreate = true,
  ): Promise<void> {
    await this.wallet.request('get_version');
    try {
      await this.wallet.request('open_wallet', { filename: credentials.filename, password: credentials.walletPassword });
    } catch (openError) {
      if (credentials.seed) {
        try {
          await this.wallet.request('restore_deterministic_wallet', {
            filename: credentials.filename,
            password: credentials.walletPassword,
            language: 'English',
            seed: credentials.seed,
            ...(credentials.restoreHeight === undefined ? {} : { restore_height: credentials.restoreHeight }),
          });
        } catch {
          throw new Error('Could not restore the configured reserve wallet');
        }
      } else if (allowCreate) {
        try {
          await this.wallet.request('create_wallet', {
            filename: credentials.filename, password: credentials.walletPassword, language: 'English',
          });
        } catch {
          throw openError;
        }
      } else {
        throw new Error('Reserve wallet is missing; a recovery seed is required');
      }
    }
    await this.wallet.request('store');
    await this.verifyNetwork(false);
  }

  /** True when the wallet's scanned height is close enough to the daemon tip to trust its transfer list. */
  private async walletCaughtUp(info: Record<string, unknown>): Promise<boolean> {
    const daemonHeight = integer(info.height, 'daemon height');
    const walletHeight = integer((await this.wallet.request('get_height')).height, 'wallet height');
    return daemonHeight - walletHeight <= MAX_WALLET_LAG_BLOCKS;
  }

  async getDepositAddress(account: string, signature: string): Promise<MoneroDepositAddress> {
    let signer: string;
    try {
      signer = this.runtime.normalizeAccount(account);
      const message = this.runtime.depositAddressMessage(signer, this.network);
      if (!await this.runtime.verifyAccountSignature(signer, message, signature)) {
        throw new Error('Signature does not match account');
      }
    } catch {
      throw new InputError('INVALID_ACCOUNT_SIGNATURE', 'A valid XMRVM account signature is required', 401);
    }

    await this.verifyNetwork(false);
    return this.runtime.depositAddress(signer, async () => {
      const result = await this.wallet.request('create_address', { account_index: 0 });
      if (typeof result.address !== 'string' || result.address.length < 90) {
        throw new Error(`Monero wallet returned an invalid ${this.network} address`);
      }
      const major = integer(result.account_index ?? 0, 'subaddress account index');
      const minor = integer(result.address_index, 'subaddress index');
      const validation = await this.wallet.request('validate_address', {
        address: result.address,
        any_net_type: false,
        allow_openalias: false,
      });
      if (validation.valid !== true || validation.nettype !== this.network) {
        throw new Error(`Wallet-created deposit address is not a valid ${this.network} address`);
      }
      return { address: result.address, major, minor };
    });
  }

  async scanDeposits() {
    if (this.scanning) return { skipped: true, credited: 0, network: this.network };
    this.scanning = true;
    try {
      const info = await this.verifyNetwork();
      if (!await this.walletCaughtUp(info)) return { skipped: true, credited: 0, network: this.network, reason: 'WALLET_REFRESHING' };
      const [assignments, previouslyCredited, transferResult] = await Promise.all([
        this.runtime.depositAddresses(),
        this.runtime.moneroDeposits(),
        this.wallet.request('get_transfers', { in: true, account_index: 0 }),
      ]);
      const incoming = transferResult.in;
      if (!Array.isArray(incoming)) throw new Error('Wallet returned no incoming-transfer list');
      const assignedByIndex = new Map(assignments.map((entry) =>
        [`${entry.major}:${entry.minor}`, entry] as const));
      const current = new Map<string, {
        txid: string; major: number; minor: number; amount: string; height: number;
        confirmations: number; locked: boolean; doubleSpendSeen: boolean;
      }>();

      for (const item of incoming) {
        const transfer = rpcRecord(item);
        const index = rpcRecord(transfer.subaddr_index);
        const major = integer(index.major, 'transfer account index');
        const minor = integer(index.minor, 'transfer address index');
        const txid = transfer.txid;
        if (typeof txid !== 'string' || !/^[a-f0-9]{64}$/.test(txid)) {
          throw new Error('Wallet returned an invalid transfer ID');
        }
        const transferRecord = {
          txid,
          major,
          minor,
          amount: piconeroToUnits(decimal(transfer.amount), this.scale),
          height: integer(transfer.height, 'transfer height'),
          confirmations: integer(transfer.confirmations, 'transfer confirmations'),
          locked: transfer.locked === true,
          doubleSpendSeen: transfer.double_spend_seen === true,
        };
        const id = `${txid}:${major}:${minor}`;
        if (current.has(id)) {
          throw new Error('Wallet returned duplicate incoming transfer identities');
        }
        current.set(id, transferRecord);
      }

      for (const credited of previouslyCredited) {
        const observed = current.get(`${credited.txid}:${credited.major}:${credited.minor}`);
        if (!observed || observed.amount !== credited.amount ||
            observed.height !== credited.height ||
            observed.confirmations < this.confirmations || observed.locked ||
            observed.doubleSpendSeen) {
          await this.runtime.haltMoneroBridge('DEPOSIT_REORG_OR_WALLET_VIEW_CHANGED');
          throw new InputError('MONERO_RECONCILIATION_REQUIRED',
            `A credited ${this.network} transfer changed or disappeared; payouts are paused for review`, 503);
        }
      }

      let creditedCount = 0;
      for (const transfer of current.values()) {
        const assignment = assignedByIndex.get(`${transfer.major}:${transfer.minor}`);
        if (!assignment || transfer.height < 1 || transfer.confirmations < this.confirmations ||
            transfer.locked || transfer.doubleSpendSeen) continue;
        const result = await this.runtime.creditMoneroDeposit({
          txid: transfer.txid,
          major: transfer.major,
          minor: transfer.minor,
          account: assignment.account,
          amount: transfer.amount,
          height: transfer.height,
          confirmations: transfer.confirmations,
        });
        if (!result.replay) creditedCount += 1;
      }
      this.lastScan = new Date().toISOString();
      return { skipped: false, credited: creditedCount, network: this.network, scannedTransfers: current.size };
    } finally {
      this.scanning = false;
    }
  }

  async processWithdrawals() {
    if (!this.withdrawalsEnabled) return { skipped: true, processed: 0 };
    if (this.scanning) return { skipped: true, processed: 0 };
    this.scanning = true;
    try {
      const bridgeStatus = await this.runtime.moneroBridgeStatus();
      let recoveryWithdrawal: { id: string; txid: string } | null = null;
      const recoveringChainView = bridgeStatus.state === 'RECONCILIATION_REQUIRED' &&
        bridgeStatus.reason === 'WITHDRAWAL_CHAIN_VIEW_UNAVAILABLE';
      if (bridgeStatus.state !== 'ACTIVE' && !recoveringChainView) {
        throw new InputError('MONERO_RECONCILIATION_REQUIRED',
          `Monero ${this.network} payouts are paused for reserve reconciliation`, 503);
      }
      await this.verifyNetwork();
      const withdrawals = await this.runtime.pendingWithdrawals();
      if (recoveringChainView) {
        const submitted = withdrawals.filter((withdrawal) =>
          withdrawal.state === 'SUBMITTED' && typeof withdrawal.moneroTxHash === 'string');
        if (submitted.length !== 1) {
          throw new InputError('MONERO_RECONCILIATION_REQUIRED',
            'Submitted payout could not be uniquely identified for chain-view recovery', 503);
        }
        recoveryWithdrawal = { id: submitted[0]!.id, txid: submitted[0]!.moneroTxHash! };
      }
      let processed = 0;
      for (const withdrawal of withdrawals) {
        if (withdrawal.state === 'RESERVED') {
          const validation = await this.wallet.request('validate_address', {
            address: withdrawal.destination,
            any_net_type: false,
            allow_openalias: false,
          });
          let principalPiconero: string;
          try {
            principalPiconero = unitsToPiconero(withdrawal.principal, this.scale);
            unitsToPiconero(withdrawal.feeBudget, this.scale);
            // Monero JSON-RPC carries amounts as uint64 numbers; stay within exact JS integer range.
            if (!Number.isSafeInteger(Number(principalPiconero))) throw new Error('Amount too large');
          } catch {
            principalPiconero = '';
          }
          if (validation.valid !== true || validation.nettype !== this.network || principalPiconero === '') {
            await this.runtime.transitionWithdrawal(withdrawal.id, 'cancel');
            processed += 1;
            continue;
          }
          const balance = await this.wallet.request('get_balance', { account_index: 0 });
          if (BigInt(piconeroToUnits(decimal(balance.unlocked_balance), this.scale)) <
              BigInt(withdrawal.principal) + BigInt(withdrawal.feeBudget)) continue;

          await this.runtime.beginMoneroWithdrawal(withdrawal.id);
          let signed: Record<string, unknown>;
          try {
            signed = await this.wallet.request('transfer', {
              destinations: [{ address: withdrawal.destination, amount: Number(principalPiconero) }],
              account_index: 0,
              priority: 1,
              do_not_relay: true,
              get_tx_hex: true,
              get_tx_key: false,
            });
          } catch (error) {
            if (error instanceof WalletRpcError && error.code === -4) {
              await this.runtime.cancelMoneroWithdrawalAfterDefinitiveSigningFailure(withdrawal.id);
              throw new InputError('MONERO_INSUFFICIENT_FUNDS',
                'Wallet rejected the unsigned payout for insufficient funds; the reservation was refunded', 409);
            }
            await this.runtime.haltMoneroBridge('WITHDRAWAL_SIGNING_OUTCOME_UNKNOWN');
            throw new InputError('MONERO_SIGNING_UNKNOWN',
              'Signing outcome is uncertain; the withdrawal remains locked for reconciliation', 503);
          }
          let signedAmount: string;
          let fee: string;
          try {
            signedAmount = decimal(signed.amount);
            fee = piconeroToUnits(decimal(signed.fee), this.scale);
          } catch {
            await this.runtime.haltMoneroBridge('INVALID_WITHDRAWAL_SIGNATURE_ARTIFACT');
            throw new InputError('INVALID_MONERO_ARTIFACT',
              'Wallet returned invalid payout amounts; the withdrawal remains locked', 503);
          }
          if (signedAmount !== principalPiconero ||
              typeof signed.tx_hash !== 'string' || !/^[a-f0-9]{64}$/.test(signed.tx_hash) ||
              typeof signed.tx_blob !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(signed.tx_blob)) {
            await this.runtime.haltMoneroBridge('INVALID_WITHDRAWAL_SIGNATURE_ARTIFACT');
            throw new InputError('INVALID_MONERO_ARTIFACT',
              'Wallet returned a malformed payout artifact; the withdrawal remains locked', 503);
          }
          const recorded = await this.runtime.recordMoneroWithdrawalSignature(
            withdrawal.id, signed.tx_hash, signed.tx_blob, fee,
          );
          if (recorded.state === 'PAUSED_RECONCILIATION') {
            await this.runtime.haltMoneroBridge('WITHDRAWAL_FEE_EXCEEDED_BUDGET');
            throw new InputError('MONERO_FEE_BUDGET_EXCEEDED',
              'Signed payout fee exceeds its authorized budget; the transaction was not relayed', 503);
          }
          processed += 1;
          await this.relayWithdrawal(recorded);
        } else if (withdrawal.state === 'SIGNING') {
          await this.runtime.haltMoneroBridge('WITHDRAWAL_SIGNING_OUTCOME_UNKNOWN');
          throw new InputError('MONERO_SIGNING_UNKNOWN',
            'An interrupted signing attempt needs reconciliation; the withdrawal remains locked', 503);
        } else if (withdrawal.state === 'SIGNED' || withdrawal.state === 'SUBMISSION_UNKNOWN') {
          await this.relayWithdrawal(withdrawal);
          processed += 1;
        } else if ((withdrawal.state === 'SUBMITTED' || withdrawal.state === 'SETTLED_POLICY') &&
            withdrawal.moneroTxHash) {
          let transfer: Record<string, unknown> | undefined;
          try {
            const result = await this.wallet.request('get_transfers', {
              out: true,
              pending: true,
              account_index: 0,
            });
            const candidates = ['out', 'pending'].flatMap((key) =>
              Array.isArray(result[key]) ? result[key] as unknown[] : []);
            transfer = candidates.map(rpcRecord).find((candidate) => candidate.txid === withdrawal.moneroTxHash);
          } catch {
            await this.runtime.haltMoneroBridge('WITHDRAWAL_CHAIN_VIEW_UNAVAILABLE');
            throw new InputError('MONERO_RECONCILIATION_REQUIRED',
              'Payout is missing from the wallet chain view; payouts are paused for review', 503);
          }
          if (!transfer) {
            await this.runtime.haltMoneroBridge('WITHDRAWAL_CHAIN_VIEW_UNAVAILABLE');
            throw new InputError('MONERO_RECONCILIATION_REQUIRED',
              'Payout is missing from the wallet chain view; payouts are paused for review', 503);
          }
          const txid = transfer.txid;
          let paid: string;
          let fee: string;
          let confirmations: number;
          try {
            paid = piconeroToUnits(decimal(transfer.amount), this.scale);
            fee = piconeroToUnits(decimal(transfer.fee), this.scale);
            confirmations = integer(transfer.confirmations, 'payout confirmations');
          } catch {
            await this.runtime.haltMoneroBridge('WITHDRAWAL_CHAIN_VIEW_UNAVAILABLE');
            throw new InputError('MONERO_RECONCILIATION_REQUIRED',
              'Wallet returned incomplete payout data; payouts are paused for review', 503);
          }
          if (txid !== withdrawal.moneroTxHash ||
              paid !== withdrawal.principal || fee !== withdrawal.actualFee ||
              transfer.double_spend_seen === true ||
              !['out', 'pending'].includes(String(transfer.type))) {
            await this.runtime.haltMoneroBridge('WITHDRAWAL_CHAIN_VIEW_MISMATCH');
            throw new InputError('MONERO_RECONCILIATION_REQUIRED',
              `Monero ${this.network} payout differs from its signed record; further payouts are paused`, 503);
          }
          if (recoveryWithdrawal?.id === withdrawal.id && recoveryWithdrawal.txid === txid) {
            const verifiedView: VerifiedMoneroWithdrawalView = {
              txid,
              amount: paid,
              fee,
              type: transfer.type as 'out' | 'pending',
              doubleSpendSeen: transfer.double_spend_seen === true,
            };
            await this.runtime.resumeMoneroBridgeAfterVerifiedWithdrawal(withdrawal.id, verifiedView);
            recoveryWithdrawal = null;
          }
          if (withdrawal.state === 'SETTLED_POLICY' &&
              (transfer.type !== 'out' || confirmations < this.confirmations)) {
            await this.runtime.haltMoneroBridge('SETTLED_WITHDRAWAL_REORG_OR_CONFIRMATION_LOSS');
            throw new InputError('MONERO_RECONCILIATION_REQUIRED',
              `A settled Monero ${this.network} payout lost its confirmed chain view; payouts are paused for review`, 503);
          }
          if (withdrawal.state === 'SUBMITTED' && transfer.type === 'out' &&
              confirmations >= this.confirmations) {
            await this.runtime.transitionWithdrawal(withdrawal.id, 'settle', fee);
            processed += 1;
          }
        }
      }
      return { skipped: false, processed };
    } finally {
      this.scanning = false;
    }
  }

  private async relayWithdrawal(withdrawal: Awaited<ReturnType<LedgerRuntime['pendingWithdrawals']>>[number]) {
    if (!withdrawal.moneroTxHash || !withdrawal.signedTxBlob) {
      await this.runtime.haltMoneroBridge('SIGNED_WITHDRAWAL_ARTIFACT_MISSING');
      throw new InputError('MONERO_RECONCILIATION_REQUIRED',
        'Signed payout artifact is missing; withdrawal remains locked', 503);
    }
    try {
      const result = await this.daemon.relay(withdrawal.signedTxBlob);
      if (result.status !== 'OK' || result.not_relayed === true || result.sanity_check_failed === true ||
          result.double_spend === true || result.invalid_input === true || result.invalid_output === true) {
        throw new Error(`Monero ${this.network} daemon did not accept the signed payout for relay`);
      }
      await this.runtime.markMoneroWithdrawalSubmitted(withdrawal.id, withdrawal.moneroTxHash);
    } catch (error) {
      if (error instanceof InputError && error.code === 'MONERO_TX_MISMATCH') throw error;
      await this.runtime.markMoneroWithdrawalUnknown(withdrawal.id);
      throw new InputError('MONERO_SUBMISSION_UNKNOWN',
        'Payout submission is uncertain; the same signed transaction will be reconciled before retry', 503);
    }
  }

  async status() {
    const [info, accounting, bridge, walletHeight] = await Promise.all([
      this.daemon.info(), this.runtime.info(), this.runtime.moneroBridgeStatus(),
      this.wallet.request('get_height').then((r) => (typeof r.height === 'number' ? r.height : null), () => null),
    ]);
    return {
      network: info.nettype === this.network ? this.network : 'unexpected',
      nodeSynchronized: info.synchronized === true,
      nodeHeight: typeof info.height === 'number' ? info.height : null,
      nodeTargetHeight: typeof info.target_height === 'number' ? info.target_height : null,
      walletHeight,
      confirmationsRequired: this.confirmations,
      unitsPerPiconero: this.scale.toString(),
      lastDepositScan: this.lastScan,
      accounting: accounting.accounting,
      bridge,
    };
  }
}
