import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  address, type Address, getBase58Encoder, getBase58Decoder, getBase64Encoder, getBase64Decoder,
  getTransactionDecoder, getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, getTokenDecoder, getMintDecoder, AccountState } from '@solana-program/token';
import type { LiteSVM } from 'litesvm';
import { InputError } from './errors.js';
import { SVM_GENESIS_HASH, XMR_DECIMALS, type SvmRuntime, type SvmReceipt } from './svm-runtime.js';
import type { MoneroBridge } from './monero-bridge.js';

/**
 * Solana JSON-RPC surface for the private SVM ledger: enough of the standard API for Phantom,
 * @solana/web3.js and @solana/kit to connect with just the RPC URL. Each admitted transaction
 * is one slot; there are no real blocks, leaders or epochs.
 */

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SOLANA_VERSION = '2.1.0-xmrvm';

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

type Params = unknown[];
type Encoding = 'base64' | 'base58' | 'jsonParsed' | 'json' | 'base64+zstd';

function pubkey(value: unknown, field: string): Address {
  if (typeof value !== 'string') throw new RpcError(-32602, `Invalid ${field}`);
  try {
    return address(value);
  } catch {
    throw new RpcError(-32602, `Invalid ${field}: not a base58 public key`);
  }
}

function config(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function encoding(cfg: Record<string, unknown>, fallback: Encoding): Encoding {
  const value = cfg.encoding;
  if (value === undefined) return fallback;
  if (value === 'base64' || value === 'base58' || value === 'jsonParsed' || value === 'json' || value === 'base64+zstd') return value;
  throw new RpcError(-32602, 'Unsupported encoding');
}

function context(slot: number) {
  return { apiVersion: SOLANA_VERSION, slot };
}

function decodeBytes(value: string, enc: unknown): Uint8Array {
  if (enc === 'base58') return new Uint8Array(getBase58Encoder().encode(value));
  return new Uint8Array(getBase64Encoder().encode(value));
}

function encodeData(data: Uint8Array, enc: Encoding): unknown {
  if (enc === 'base58') {
    if (data.length > 128) throw new RpcError(-32600, 'base58 encoding is limited to 128 bytes; use base64');
    return [getBase58Decoder().decode(data), 'base58'];
  }
  return [getBase64Decoder().decode(data), 'base64'];
}

function parsedTokenData(owner: string, data: Uint8Array): unknown | null {
  if (owner !== TOKEN_PROGRAM_ADDRESS) return null;
  if (data.length === 165) {
    const token = getTokenDecoder().decode(data);
    return {
      program: 'spl-token',
      space: 165,
      parsed: {
        type: 'account',
        info: {
          mint: token.mint,
          owner: token.owner,
          tokenAmount: amountView(token.amount, XMR_DECIMALS),
          state: token.state === AccountState.Frozen ? 'frozen' : token.state === AccountState.Initialized ? 'initialized' : 'uninitialized',
          isNative: token.isNative.__option === 'Some',
          delegate: token.delegate.__option === 'Some' ? token.delegate.value : null,
          delegatedAmount: amountView(token.delegatedAmount, XMR_DECIMALS),
          closeAuthority: token.closeAuthority.__option === 'Some' ? token.closeAuthority.value : null,
        },
      },
    };
  }
  if (data.length === 82) {
    const mint = getMintDecoder().decode(data);
    return {
      program: 'spl-token',
      space: 82,
      parsed: {
        type: 'mint',
        info: {
          decimals: mint.decimals,
          supply: mint.supply.toString(),
          isInitialized: mint.isInitialized,
          mintAuthority: mint.mintAuthority.__option === 'Some' ? mint.mintAuthority.value : null,
          freezeAuthority: mint.freezeAuthority.__option === 'Some' ? mint.freezeAuthority.value : null,
        },
      },
    };
  }
  return null;
}

function amountView(amount: bigint, decimals: number) {
  const whole = amount / 10n ** BigInt(decimals);
  const fraction = (amount % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  const uiAmountString = decimals === 0 ? whole.toString() : `${whole}.${fraction}`.replace(/\.?0+$/, '') || '0';
  return {
    amount: amount.toString(),
    decimals,
    uiAmount: Number(uiAmountString),
    uiAmountString,
  };
}

function accountView(svm: LiteSVM, key: Address, enc: Encoding, slice?: { offset: number; length: number }) {
  const account = svm.getAccount(key);
  if (!account.exists) return null;
  const owner = String(account.programAddress);
  let data: unknown;
  if (enc === 'jsonParsed') {
    data = parsedTokenData(owner, account.data) ?? encodeData(account.data, 'base64');
  } else {
    const bytes = slice ? account.data.slice(slice.offset, slice.offset + slice.length) : account.data;
    data = encodeData(bytes, enc === 'base64+zstd' ? 'base64' : enc);
  }
  return {
    lamports: Number(account.lamports),
    owner,
    data,
    executable: account.executable,
    rentEpoch: 0,
    space: account.data.length,
  };
}

function receiptStatus(receipt: SvmReceipt) {
  return receipt.success ? null : { InstructionError: [0, receipt.error] };
}

function transactionView(receipt: SvmReceipt, enc: Encoding) {
  const bytes = new Uint8Array(getBase64Encoder().encode(receipt.raw));
  const decoded = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes) as unknown as {
    version: 'legacy' | number; header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[]; lifetimeToken: string;
    instructions: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>;
  };
  const meta = {
    err: receiptStatus(receipt),
    status: receipt.success ? { Ok: null } : { Err: receiptStatus(receipt) },
    fee: Number(receipt.fee),
    preBalances: receipt.preBalances.map(Number),
    postBalances: receipt.postBalances.map(Number),
    innerInstructions: [],
    logMessages: receipt.logs,
    preTokenBalances: [],
    postTokenBalances: [],
    rewards: [],
    computeUnitsConsumed: Number(receipt.computeUnits),
    loadedAddresses: { readonly: [], writable: [] },
  };
  const transaction = enc === 'base64' || enc === 'base58'
    ? encodeData(bytes, enc)
    : {
      signatures: Object.values(decoded.signatures).map((s) => getBase58Decoder().decode(s ?? new Uint8Array(64))),
      message: {
        accountKeys: enc === 'jsonParsed'
          ? compiled.staticAccounts.map((key, index) => ({
            pubkey: key,
            signer: index < compiled.header.numSignerAccounts,
            writable: index < compiled.header.numSignerAccounts - compiled.header.numReadonlySignerAccounts ||
              (index >= compiled.header.numSignerAccounts &&
                index < compiled.staticAccounts.length - compiled.header.numReadonlyNonSignerAccounts),
            source: 'transaction',
          }))
          : compiled.staticAccounts,
        header: compiled.header,
        recentBlockhash: compiled.lifetimeToken,
        instructions: compiled.instructions.map((ix) => (enc === 'jsonParsed'
          ? {
            programId: compiled.staticAccounts[ix.programAddressIndex],
            accounts: (ix.accountIndices ?? []).map((i) => compiled.staticAccounts[i]),
            data: getBase58Decoder().decode(ix.data ?? new Uint8Array()),
            stackHeight: null,
          }
          : {
            programIdIndex: ix.programAddressIndex,
            accounts: ix.accountIndices ?? [],
            data: getBase58Decoder().decode(ix.data ?? new Uint8Array()),
            stackHeight: null,
          })),
        addressTableLookups: [],
      },
    };
  return {
    slot: receipt.slot,
    blockTime: receipt.blockTime,
    transaction,
    meta,
    version: compiled.version === 'legacy' ? 'legacy' : compiled.version,
  };
}

export interface SolanaRpcDependencies {
  runtime: SvmRuntime;
  bridge?: MoneroBridge | undefined;
  /** When true, `requestAirdrop` mints XMR units (simulation faucet). */
  faucet: boolean;
  /** Exposes only deposit and account-read methods, never transaction submission. */
  depositOnly?: boolean;
}

const DEPOSIT_ONLY_METHODS = new Set([
  'getVersion', 'getHealth', 'getGenesisHash', 'getSlot', 'getBlockHeight',
  'getEpochInfo', 'getTokenAccountsByOwner', 'getTokenAccountBalance',
  'xmrvm_info', 'xmrvm_bridgeStatus', 'xmrvm_getDepositAddress', 'xmrvm_depositAddressMessage',
]);

export async function dispatch(deps: SolanaRpcDependencies, method: string, params: Params): Promise<unknown> {
  const { runtime, bridge } = deps;
  if (deps.depositOnly && !DEPOSIT_ONLY_METHODS.has(method)) {
    throw new RpcError(-32601, 'Method is disabled in deposit-only mode');
  }
  const slot = async () => (await runtime.info()).sequence;
  switch (method) {
    case 'getVersion': return { 'solana-core': SOLANA_VERSION, 'feature-set': 0 };
    case 'getHealth': return 'ok';
    case 'getGenesisHash': return SVM_GENESIS_HASH;
    case 'getIdentity': return { identity: (await runtime.info()).authority };
    case 'getSlot':
    case 'getBlockHeight':
    case 'getMaxRetransmitSlot':
    case 'getMaxShredInsertSlot':
    case 'getFirstAvailableBlock':
      return method === 'getFirstAvailableBlock' ? 0 : slot();
    case 'getEpochInfo': {
      const current = await slot();
      return { absoluteSlot: current, blockHeight: current, epoch: 0, slotIndex: current, slotsInEpoch: 432_000, transactionCount: current };
    }
    case 'getEpochSchedule': return { slotsPerEpoch: 432_000, leaderScheduleSlotOffset: 432_000, warmup: false, firstNormalEpoch: 0, firstNormalSlot: 0 };
    case 'getLatestBlockhash': {
      const info = await runtime.info();
      return { context: context(info.sequence), value: { blockhash: info.blockhash, lastValidBlockHeight: info.sequence + 150 } };
    }
    case 'getRecentBlockhash': {
      const info = await runtime.info();
      return { context: context(info.sequence), value: { blockhash: info.blockhash, feeCalculator: { lamportsPerSignature: 5000 } } };
    }
    case 'isBlockhashValid': {
      const info = await runtime.info();
      return { context: context(info.sequence), value: params[0] === info.blockhash };
    }
    case 'getFeeForMessage': {
      const current = await slot();
      return { context: context(current), value: 5000 };
    }
    case 'getRecentPrioritizationFees': return [];
    case 'getMinimumBalanceForRentExemption': {
      const size = typeof params[0] === 'number' ? params[0] : Number(params[0] ?? 0);
      if (!Number.isSafeInteger(size) || size < 0) throw new RpcError(-32602, 'Invalid data length');
      return Number(await runtime.read((svm) => svm.minimumBalanceForRentExemption(BigInt(size))));
    }
    case 'getBalance': {
      const key = pubkey(params[0], 'pubkey');
      const current = await slot();
      return { context: context(current), value: Number(await runtime.read((svm) => svm.getBalance(key) ?? 0n)) };
    }
    case 'getAccountInfo': {
      const key = pubkey(params[0], 'pubkey');
      const cfg = config(params[1]);
      const enc = encoding(cfg, 'base64');
      const slice = cfg.dataSlice ? config(cfg.dataSlice) as { offset: number; length: number } : undefined;
      const [current, value] = await Promise.all([slot(), runtime.read((svm) => accountView(svm, key, enc, slice))]);
      return { context: context(current), value };
    }
    case 'getMultipleAccounts': {
      if (!Array.isArray(params[0]) || params[0].length > 100) throw new RpcError(-32602, 'Expected up to 100 pubkeys');
      const keys = params[0].map((k) => pubkey(k, 'pubkey'));
      const cfg = config(params[1]);
      const enc = encoding(cfg, 'base64');
      const [current, value] = await Promise.all([slot(), runtime.read((svm) => keys.map((k) => accountView(svm, k, enc)))]);
      return { context: context(current), value };
    }
    case 'getProgramAccounts': {
      const program = pubkey(params[0], 'program id');
      const cfg = config(params[1]);
      const enc = encoding(cfg, 'base64');
      const filters = Array.isArray(cfg.filters) ? cfg.filters.map(config) : [];
      const withContext = cfg.withContext === true;
      const [current, value] = await Promise.all([slot(), runtime.read((svm) => svm.getProgramAccounts(program)
        .filter((acc) => filters.every((filter) => {
          if (typeof filter.dataSize === 'number') return acc.data.length === filter.dataSize;
          if (filter.memcmp) {
            const cmp = config(filter.memcmp);
            const offset = Number(cmp.offset ?? 0);
            const needle = decodeBytes(String(cmp.bytes ?? ''), cmp.encoding ?? 'base58');
            return Buffer.from(acc.data.slice(offset, offset + needle.length)).equals(Buffer.from(needle));
          }
          return true;
        }))
        .map((acc) => ({ pubkey: acc.address, account: accountView(svm, acc.address, enc) })))]);
      return withContext ? { context: context(current), value } : value;
    }
    case 'getTokenAccountsByOwner': {
      const owner = pubkey(params[0], 'owner');
      const filter = config(params[1]);
      const cfg = config(params[2]);
      const enc = encoding(cfg, 'jsonParsed');
      const mintFilter = filter.mint !== undefined ? pubkey(filter.mint, 'mint') : null;
      const [current, value] = await Promise.all([slot(), runtime.read((svm) => svm.getProgramAccounts(TOKEN_PROGRAM_ADDRESS)
        .filter((acc) => acc.data.length === 165)
        .filter((acc) => {
          const token = getTokenDecoder().decode(acc.data);
          return token.owner === owner && (!mintFilter || token.mint === mintFilter);
        })
        .map((acc) => ({ pubkey: acc.address, account: accountView(svm, acc.address, enc) })))]);
      return { context: context(current), value };
    }
    case 'getTokenAccountBalance': {
      const key = pubkey(params[0], 'token account');
      const [current, value] = await Promise.all([slot(), runtime.read((svm) => {
        const acc = svm.getAccount(key);
        if (!acc.exists || acc.data.length !== 165) throw new RpcError(-32602, 'Invalid param: not a Token account');
        return amountView(getTokenDecoder().decode(acc.data).amount, XMR_DECIMALS);
      })]);
      return { context: context(current), value };
    }
    case 'getTokenSupply': {
      const key = pubkey(params[0], 'mint');
      const [current, value] = await Promise.all([slot(), runtime.read((svm) => {
        const acc = svm.getAccount(key);
        if (!acc.exists || acc.data.length !== 82) throw new RpcError(-32602, 'Invalid param: not a Mint account');
        const mint = getMintDecoder().decode(acc.data);
        return amountView(mint.supply, mint.decimals);
      })]);
      return { context: context(current), value };
    }
    case 'sendTransaction': {
      if (typeof params[0] !== 'string') throw new RpcError(-32602, 'Expected an encoded transaction');
      const cfg = config(params[1]);
      const bytes = decodeBytes(params[0], cfg.encoding ?? 'base58');
      const receipt = await runtime.submit(bytes);
      if (!receipt.success && cfg.skipPreflight !== true) {
        throw new RpcError(-32002, `Transaction simulation failed: ${receipt.error}`, { err: receiptStatus(receipt), logs: receipt.logs });
      }
      return receipt.signature;
    }
    case 'simulateTransaction': {
      if (typeof params[0] !== 'string') throw new RpcError(-32602, 'Expected an encoded transaction');
      const cfg = config(params[1]);
      const bytes = decodeBytes(params[0], cfg.encoding ?? 'base58');
      const result = await runtime.simulate(getBase64Decoder().decode(bytes));
      return {
        context: context(await slot()),
        value: {
          err: result.success ? null : { InstructionError: [0, result.error] },
          logs: result.logs,
          accounts: null,
          unitsConsumed: Number(result.computeUnits),
          returnData: null,
        },
      };
    }
    case 'getSignatureStatuses': {
      if (!Array.isArray(params[0])) throw new RpcError(-32602, 'Expected signature list');
      const current = await slot();
      const value = await Promise.all(params[0].map(async (sig) => {
        const receipt = typeof sig === 'string' ? await runtime.receipt(sig) : null;
        if (!receipt) return null;
        return {
          slot: receipt.slot,
          confirmations: null,
          err: receiptStatus(receipt),
          status: receipt.success ? { Ok: null } : { Err: receiptStatus(receipt) },
          confirmationStatus: 'finalized',
        };
      }));
      return { context: context(current), value };
    }
    case 'getTransaction': {
      if (typeof params[0] !== 'string') throw new RpcError(-32602, 'Expected a signature');
      const receipt = await runtime.receipt(params[0]);
      if (!receipt) return null;
      return transactionView(receipt, encoding(config(params[1]), 'json'));
    }
    case 'getSignaturesForAddress': {
      const key = String(pubkey(params[0], 'address'));
      const cfg = config(params[1]);
      const limit = Math.min(Number(cfg.limit ?? 1000), 1000);
      return runtime.read((_svm, snapshot) => {
        const out = [];
        for (let i = snapshot.signatures.length - 1; i >= 0 && out.length < limit; i -= 1) {
          const receipt = snapshot.receipts[snapshot.signatures[i]!];
          if (!receipt || !receipt.accounts.includes(key)) continue;
          if (cfg.before && receipt.signature === cfg.before) { out.length = 0; continue; }
          out.push({ signature: receipt.signature, slot: receipt.slot, err: receiptStatus(receipt), memo: null, blockTime: receipt.blockTime, confirmationStatus: 'finalized' });
        }
        return out;
      });
    }
    case 'getBlock': {
      const number = Number(params[0]);
      const cfg = config(params[1]);
      return runtime.read((_svm, snapshot) => {
        if (!Number.isSafeInteger(number) || number < 0 || number > snapshot.sequence) throw new RpcError(-32009, 'Slot was skipped, or missing');
        const signature = number === 0 ? null : snapshot.signatures[number - 1] ?? null;
        const receipt = signature ? snapshot.receipts[signature] : undefined;
        const blockhash = snapshot.signatures[number - 1] ?? SVM_GENESIS_HASH;
        const detail = cfg.transactionDetails ?? 'full';
        return {
          blockhash,
          previousBlockhash: number <= 1 ? SVM_GENESIS_HASH : snapshot.signatures[number - 2],
          parentSlot: Math.max(0, number - 1),
          blockHeight: number,
          blockTime: receipt?.blockTime ?? null,
          transactions: receipt && detail === 'full' ? [transactionView(receipt, encoding(cfg, 'json'))] : [],
          signatures: detail === 'signatures' && signature ? [signature] : undefined,
          rewards: [],
        };
      });
    }
    case 'getBlocks': {
      const start = Number(params[0]);
      const current = await slot();
      const end = params[1] === undefined ? current : Math.min(Number(params[1]), current);
      if (!Number.isSafeInteger(start) || start < 0) throw new RpcError(-32602, 'Invalid start slot');
      return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
    }
    case 'getBlockTime': {
      const number = Number(params[0]);
      return runtime.read((_svm, snapshot) => {
        const signature = snapshot.signatures[number - 1];
        return signature ? snapshot.receipts[signature]?.blockTime ?? null : null;
      });
    }
    case 'getSupply': {
      const current = await slot();
      return { context: context(current), value: { total: 0, circulating: 0, nonCirculating: 0, nonCirculatingAccounts: [] } };
    }
    case 'getClusterNodes': return [];
    case 'getVoteAccounts': return { current: [], delinquent: [] };
    case 'getInflationGovernor': return { foundation: 0, foundationTerm: 0, initial: 0, taper: 0, terminal: 0 };
    case 'getInflationRate': return { epoch: 0, foundation: 0, total: 0, validator: 0 };
    case 'getLeaderSchedule': return null;
    case 'getSlotLeader': return (await runtime.info()).authority;
    case 'minimumLedgerSlot': return 0;
    case 'getHighestSnapshotSlot': { const current = await slot(); return { full: current, incremental: null }; }
    case 'getTransactionCount': return slot();
    case 'requestAirdrop': {
      if (!deps.faucet) throw new RpcError(-32601, 'Airdrop is disabled: fund accounts with Stagenet XMR deposits');
      const key = pubkey(params[0], 'pubkey');
      const amount = BigInt(String(params[1] ?? '0'));
      if (amount <= 0n || amount > 10n ** 15n) throw new RpcError(-32602, 'Invalid airdrop amount');
      const receipt = await runtime.deposit(`airdrop:${key}:${Date.now()}`, key, amount.toString());
      return `faucet:${receipt.id}`;
    }

    // XMRVM extensions
    case 'xmrvm_info': {
      const info = await runtime.info();
      const bridgeStatus = bridge ? await bridge.status() : null;
      return {
        ...info,
        mode: deps.depositOnly ? 'MAINNET_DEPOSIT_ONLY' : bridge ? `${String(bridgeStatus?.network).toUpperCase()}_BRIDGE` : info.mode,
        network: bridgeStatus?.network ?? null,
        moneroConfigured: Boolean(bridge),
        withdrawalsEnabled: !deps.depositOnly,
      };
    }
    case 'xmrvm_bridgeStatus': {
      if (!bridge) throw new RpcError(-32601, 'Monero bridge is not configured');
      return bridge.status();
    }
    case 'xmrvm_getDepositAddress': {
      if (!bridge) throw new RpcError(-32601, 'Monero bridge is not configured');
      if (typeof params[1] !== 'string') throw new RpcError(-32602, 'Expected an account signature');
      return bridge.getDepositAddress(String(pubkey(params[0], 'account')), params[1]);
    }
    case 'xmrvm_depositAddressMessage': {
      const account = String(pubkey(params[0], 'account'));
      return bridge ? bridge.depositAddressMessage(account) : runtime.depositAddressMessage(account);
    }
    case 'xmrvm_getWithdrawal': {
      if (typeof params[0] !== 'string' || !/^[0-9]{1,20}$/.test(params[0])) throw new RpcError(-32602, 'Invalid withdrawal ID');
      const withdrawal = await runtime.withdrawal(params[0]);
      if (!withdrawal) return null;
      const { signedTxBlob: _blob, ...view } = withdrawal;
      return view;
    }
    case 'xmrvm_deployProgram': {
      if (typeof params[1] !== 'string') throw new RpcError(-32602, 'Expected base64 program bytes');
      return runtime.deployProgram(String(pubkey(params[0], 'program id')), params[1]);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function errorBody(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError) return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
  if (error instanceof InputError) return { code: -32002, message: error.message, data: { code: error.code } };
  console.error('Solana RPC internal failure', error);
  return { code: -32603, message: 'Internal error' };
}

async function handleOne(deps: SolanaRpcDependencies, request: unknown): Promise<unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  const { id = null, method, params } = request as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== 'string') return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
  const list: Params = params === undefined ? [] : Array.isArray(params) ? params : [params];
  try {
    return { jsonrpc: '2.0', id, result: await dispatch(deps, method, list) };
  } catch (error) {
    return { jsonrpc: '2.0', id, error: errorBody(error) };
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new RpcError(-32600, 'Request exceeds 1 MiB');
    parts.push(buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

function cors(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, solana-client');
  response.setHeader('Access-Control-Max-Age', '600');
}

function clientAddress(request: IncomingMessage): string {
  const remote = request.socket.remoteAddress ?? 'unknown';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = request.headers['x-forwarded-for'];
  if (!loopback || typeof forwarded !== 'string') return remote;
  const client = forwarded.split(',')[0]?.trim();
  return client && isIP(client) ? client : remote;
}

export function solanaRpcServer(deps: SolanaRpcDependencies) {
  const rateWindows = new Map<string, { started: number; requests: number }>();
  const server = createServer((request, response) => {
    cors(response);
    void (async () => {
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (deps.depositOnly) {
        const now = Date.now();
        const ip = clientAddress(request);
        const window = rateWindows.get(ip);
        if (!window || now - window.started >= 60_000) {
          rateWindows.set(ip, { started: now, requests: 1 });
        } else if (++window.requests > 120) {
          response.writeHead(429, { 'Retry-After': '60', 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        if (rateWindows.size > 10_000) {
          for (const [key, value] of rateWindows) {
            if (now - value.started >= 60_000) rateWindows.delete(key);
          }
        }
      }
      if (request.method === 'GET' && (request.url === '/health' || request.url === '/')) {
        response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('ok'); return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'POST required' } }));
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: error instanceof RpcError
          ? { code: error.code, message: error.message } : { code: -32700, message: 'Parse error' } }));
        return;
      }
      const result = Array.isArray(payload)
        ? await Promise.all(payload.map((entry) => handleOne(deps, entry)))
        : await handleOne(deps, payload);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    })().catch((error: unknown) => {
      console.error('Solana RPC request failed', error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
