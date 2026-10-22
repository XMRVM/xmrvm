import { createHash, randomBytes } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';

export interface WalletCredentials {
  username: string;
  password: string;
  filename: string;
  walletPassword: string;
  seed?: string;
  restoreHeight?: number;
}

export function walletCredentials(value: unknown): WalletCredentials {
  const record = rpcRecord(value);
  const field = (key: string): string => {
    const item = record[key];
    if (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)) {
      throw new Error('Invalid local credential file');
    }
    return item;
  };
  const seed = record.seed;
  const normalizedSeed = typeof seed === 'string' ? seed.trim().replace(/\s+/g, ' ') : undefined;
  const restoreHeight = record.restoreHeight;
  if (seed !== undefined && (normalizedSeed === undefined || !/^[a-z]+(?: [a-z]+){24}$/.test(normalizedSeed))) {
    throw new Error('Invalid local credential file');
  }
  if (restoreHeight !== undefined && (typeof restoreHeight !== 'number' ||
      !Number.isSafeInteger(restoreHeight) || restoreHeight < 0)) {
    throw new Error('Invalid local credential file');
  }
  return {
    username: field('username'),
    password: field('password'),
    filename: field('filename'),
    walletPassword: field('walletPassword'),
    ...(normalizedSeed === undefined ? {} : { seed: normalizedSeed }),
    ...(restoreHeight === undefined ? {} : { restoreHeight }),
  };
}

export function parseRpcJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error('Non-integer RPC number');
      if (!Number.isSafeInteger(value)) {
        if (!context || !/^-?[0-9]+$/.test(context.source)) throw new Error('Cannot preserve RPC integer');
        return context.source;
      }
    }
    return value;
  });
}

export function rpcRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid RPC object');
  return Object.fromEntries(Object.entries(value));
}

export type WalletMethod =
  | 'get_version' | 'create_wallet' | 'open_wallet' | 'get_address' | 'create_address'
  | 'validate_address' | 'store' | 'get_balance' | 'get_height' | 'refresh' | 'close_wallet'
  | 'get_transfers' | 'transfer' | 'get_transfer_by_txid' | 'relay_tx' | 'restore_deterministic_wallet';

export class WalletRpcError extends Error {
  constructor(readonly code: number | string) {
    super(`Wallet RPC rejected the request (code ${code})`);
    this.name = 'WalletRpcError';
  }
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function digestAttributes(challenge: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of challenge.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g)) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

function digestAuthorization(
  credentials: Pick<WalletCredentials, 'username' | 'password'>,
  challenge: string,
): string {
  if (!challenge.startsWith('Digest ')) throw new Error('Local wallet RPC did not offer Digest authentication');
  // monero-wallet-rpc offers MD5 and MD5-sess as two comma-joined challenges; pick the plain MD5 one.
  const offers = challenge.split(/,\s*(?=Digest\s)/).map((offer) => digestAttributes(offer.slice('Digest '.length)));
  const values = offers.find((offer) => !offer.algorithm || offer.algorithm.toUpperCase() === 'MD5') ?? offers[0]!;
  const realm = values.realm;
  const nonce = values.nonce;
  const qops = values.qop?.split(',').map((value) => value.trim()) ?? [];
  if (!realm || !nonce || !qops.includes('auth') ||
      (values.algorithm && values.algorithm.toUpperCase() !== 'MD5')) {
    throw new Error('Local wallet RPC offered unsupported Digest parameters');
  }
  const uri = '/json_rpc';
  const cnonce = randomBytes(16).toString('hex');
  const nonceCount = '00000001';
  const qop = 'auth';
  const md5 = (value: string) => createHash('md5').update(value).digest('hex');
  const ha1 = md5(`${credentials.username}:${realm}:${credentials.password}`);
  const ha2 = md5(`POST:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nonceCount}:${cnonce}:${qop}:${ha2}`);
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const parts = [
    `username=${quote(credentials.username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
    'algorithm=MD5',
    `qop=${quote(qop)}`,
    `nc=${nonceCount}`,
    `cnonce=${quote(cnonce)}`,
  ];
  if (values.opaque !== undefined) parts.push(`opaque=${quote(values.opaque)}`);
  return `Digest ${parts.join(',')}`;
}

function postLocal(port: number, body: string, agent: Agent, authorization?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/json_rpc',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(authorization ? { Authorization: authorization } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(new Error('Local wallet RPC response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', () => reject(new Error('Local wallet RPC response failed')));
    });
    request.setTimeout(65_000, () => request.destroy(new Error('Local wallet RPC timed out')));
    request.on('error', (error: Error) => {
      reject(error.message === 'Local wallet RPC timed out' ||
        error.message === 'Local wallet RPC response exceeded the size limit'
        ? error
        : new Error('Local wallet RPC transport failed; check service and credentials'));
    });
    request.end(body);
  });
}

export async function walletRequest(
  credentials: WalletCredentials,
  method: WalletMethod,
  params: Record<string, unknown> = {},
  port = 38088,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local RPC port');
  const localCredentials = walletCredentials(credentials);
  const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
  // monero-wallet-rpc binds the Digest nonce to the TCP connection, so both requests must share one socket.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const initial = await postLocal(port, body, agent);
    if (initial.status !== 401) {
      if (initial.status !== 200) throw new Error('Local wallet RPC transport failed; check service and credentials');
      throw new Error('Local wallet RPC accepted an unauthenticated request');
    }
    const challenge = initial.headers['www-authenticate'];
    if (typeof challenge !== 'string') throw new Error('Local wallet RPC omitted its Digest challenge');
    const authenticated = await postLocal(port, body, agent, digestAuthorization(localCredentials, challenge));
    if (authenticated.status !== 200) throw new Error('Local wallet RPC transport failed; check service and credentials');
    const response = rpcRecord(parseRpcJson(authenticated.body));
    if (response.jsonrpc !== '2.0' || response.id !== '0') throw new Error('Invalid RPC response identity');
    if ('error' in response) {
      const error = rpcRecord(response.error);
      const errorCode = typeof error.code === 'number' ? error.code : 'unknown';
      throw new WalletRpcError(errorCode);
    }
    return rpcRecord(response.result);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Malformed wallet RPC response');
    throw error;
  } finally {
    agent.destroy();
  }
}
