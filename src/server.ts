import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { MoneroBridge, moneroDaemon, localMoneroWallet } from './monero-bridge.js';
import { walletCredentials } from './monero-wallet.js';
import { solanaRpcServer } from './solana-rpc.js';
import type { Server } from 'node:http';

const rpcPort = Number(process.env.XMRVM_RPC_PORT ?? '8545');
if (!Number.isInteger(rpcPort) || rpcPort < 1 || rpcPort > 65535) throw new Error('Invalid XMRVM_RPC_PORT');
const bind = process.env.XMRVM_BIND ?? '127.0.0.1';
if (bind !== '127.0.0.1' && bind !== '0.0.0.0') throw new Error('XMRVM_BIND must be 127.0.0.1 or 0.0.0.0');
const rpcBind = process.env.XMRVM_RPC_BIND ?? bind;
if (rpcBind !== '127.0.0.1' && rpcBind !== '0.0.0.0') throw new Error('XMRVM_RPC_BIND must be 127.0.0.1 or 0.0.0.0');
const mode = process.env.XMRVM_MODE ?? 'simulation';
if (!['simulation', 'stagenet', 'mainnet'].includes(mode)) {
  throw new Error('XMRVM_MODE must be simulation, stagenet, or mainnet');
}
if (mode !== 'simulation' && process.env.MONERO_NETWORK !== mode) {
  throw new Error(`XMRVM_MODE=${mode} requires MONERO_NETWORK=${mode}`);
}
if (mode === 'stagenet' && (bind !== '127.0.0.1' || rpcBind !== '127.0.0.1')) {
  throw new Error('Stagenet mode requires loopback-only application API bindings');
}
if (mode === 'mainnet' && (process.env.XMRVM_DEPOSIT_ONLY !== 'true' ||
    process.env.XMRVM_WITHDRAWALS_ENABLED !== 'false' || rpcBind !== '127.0.0.1')) {
  throw new Error('Mainnet requires deposit-only mode, disabled withdrawals, and loopback-only RPC behind the VPS reverse tunnel');
}

const defaultDatabase = join('.xmrvm', `svm-${mode === 'stagenet' ? 'stagenet-bridge' : mode === 'mainnet' ? 'mainnet-deposit' : 'prototype'}.sqlite`);
const databasePath = resolve(process.env.XMRVM_DB ?? defaultDatabase);
const runtime = await (await import('./svm-runtime.js')).SvmRuntime.open(databasePath, {
  withdrawalsEnabled: mode !== 'mainnet' || process.env.XMRVM_WITHDRAWALS_ENABLED === 'true',
});
let server: Server | undefined;
let rpc: Server | undefined;
let scanTimer: NodeJS.Timeout | undefined;
try {
  let bridge: MoneroBridge | undefined;
  if (mode === 'stagenet' || mode === 'mainnet') {
    await runtime.assertStagenetLedger();
    const credentialsPath = resolve(process.env.MONERO_CREDENTIALS_FILE ?? join('.xmrvm', 'monero', 'credentials.json'));
    if (!existsSync(credentialsPath)) throw new Error('Local Monero wallet credentials file is missing');
    let credentials;
    try {
      credentials = walletCredentials(JSON.parse(readFileSync(credentialsPath, 'utf8')));
    } catch {
      throw new Error('Local Monero wallet credentials file is invalid');
    }
    if (mode === 'mainnet' && !credentials.seed) {
      throw new Error('Mainnet reserve wallet recovery seed is required through encrypted init parameters');
    }
    const walletPort = Number(process.env.MONERO_LOCAL_PORT ?? '38088');
    const daemonUrl = process.env.MONERO_DAEMON_URL ?? `http://127.0.0.1:${process.env.MONERO_DAEMON_PORT ?? '38081'}`;
    const walletClient = localMoneroWallet({
      username: credentials.username,
      password: credentials.password,
      filename: credentials.filename,
      walletPassword: credentials.walletPassword,
    }, walletPort);
    bridge = MoneroBridge.create(
      runtime,
      walletClient,
      moneroDaemon(daemonUrl),
      {
        network: mode,
        withdrawalsEnabled: process.env.XMRVM_WITHDRAWALS_ENABLED !== 'false',
      },
    );
    await bridge.ensureReserveWallet(credentials, mode !== 'mainnet');
    credentials = {
      username: credentials.username,
      password: credentials.password,
      filename: credentials.filename,
      walletPassword: credentials.walletPassword,
    };
    if (mode === 'mainnet' && credentialsPath === '/run/monero/credentials.json') {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(credentialsPath);
    }
    console.log(`Monero ${mode} reserve wallet open; daemon ${new URL(daemonUrl).host}.`);
  }
  if (runtime) {
    rpc = solanaRpcServer({
      runtime, bridge, faucet: mode === 'simulation',
      depositOnly: mode === 'mainnet' && process.env.XMRVM_DEPOSIT_ONLY === 'true',
    });
  }
  await new Promise<void>((accept, reject) => {
    rpc!.once('error', reject);
    rpc!.listen(rpcPort, rpcBind, accept);
  });  if (bridge) {
    const scan = async (): Promise<void> => {
      try {
        const deposits = await bridge.scanDeposits();
        const withdrawals = await bridge.processWithdrawals();
        if (deposits.credited > 0 || withdrawals.processed > 0) {
          console.log(`Stagenet bridge processed ${deposits.credited} deposit(s) and ${withdrawals.processed} payout step(s).`);
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'SCAN_FAILED';
        console.error(`Stagenet bridge cycle failed: ${code}`);
      }
    };
    await scan();
    scanTimer = setInterval(() => { void scan(); }, 30_000);
    scanTimer.unref();
  }
} catch (error) {
  if (scanTimer) clearInterval(scanTimer);
  rpc?.close();
  await runtime.close();
  throw error;
}
console.log(`XMRVM Solana JSON-RPC: http://${rpcBind}:${rpcPort}  (custom cluster; XMR SPL mint with 12 decimals)`);
if (mode === 'mainnet') console.log('MAINNET DEPOSIT-ONLY MODE. Withdrawals and transaction submission are disabled.');
else if (mode === 'stagenet') console.log('STAGENET TEST MODE. Deposits credited after confirmations; payouts relayed automatically.');
else console.log('SIMULATION MODE. No Monero connection. Operator can create simulated reserves.');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    if (scanTimer) clearInterval(scanTimer);
    rpc?.close();
    void runtime.close().catch((failure: unknown) => {
      console.error('Runtime shutdown failed', failure);
      process.exitCode = 1;
    });
  });
}
