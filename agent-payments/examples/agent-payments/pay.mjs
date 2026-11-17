import { readFile } from 'node:fs/promises';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAgentPaymentInstruction, decodeAgentConfig, decodeAgentPaymentReceipt, decodeAgentPolicy,
  deriveAgentBudgetAddress, deriveAgentConfigAddress, deriveAgentReceiptAddress, explainAgentPaymentError,
} from '../../dist/src/agent-payments-client.js';
import { deriveAssociatedTokenAddress, parseXmrAmount, createAssociatedTokenAccountIdempotentInstruction } from '../../dist/src/escrow-client.js';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
};

const rpcUrl = required('XMRVM_RPC_URL');
const endpoint = new URL(rpcUrl);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
    (endpoint.protocol !== 'https:' && !local)) {
  throw new Error('Use HTTPS for remote XMRVM endpoints.');
}

async function rpc(method, params = []) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: process.env.XMRVM_RPC_ORIGIN?.trim() || 'https://www.xmrvm.net',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.error) {
    const message = result.error.message ?? `${method} failed.`;
    throw new Error(explainAgentPaymentError(message) ?? message);
  }
  return result.result;
}

function decodeAccount(account) {
  if (!account?.data?.[0]) throw new Error('The requested account does not exist on this runtime.');
  return Uint8Array.from(Buffer.from(account.data[0], 'base64'));
}

function hex32(value, label) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be 64 hex characters (32 bytes).`);
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

const programId = new PublicKey(required('XMRVM_AGENT_PAYMENTS_PROGRAM_ID'));
const policyAddress = new PublicKey(required('XMRVM_BUDGET_ADDRESS'));
const recipient = new PublicKey(required('XMRVM_RECIPIENT'));
const paymentId = hex32(required('XMRVM_PAYMENT_ID'), 'XMRVM_PAYMENT_ID');
const amount = parseXmrAmount(required('XMRVM_PAYMENT_AMOUNT'));
const keyPath = required('XMRVM_AGENT_KEYPAIR_PATH');
const secret = JSON.parse(await readFile(keyPath, 'utf8'));
if (!Array.isArray(secret) || secret.length !== 64 || secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
  throw new Error('The agent key file must contain the 64-byte JSON array exported by Solana CLI.');
}
const agent = Keypair.fromSecretKey(Uint8Array.from(secret));

const info = await rpc('xmrvm_info');
if (info.agentPaymentsProgram !== programId.toBase58()) {
  throw new Error('The requested program ID is not the host-pinned agent-payments program.');
}
if (!info.mint || !Number.isSafeInteger(info.unixTime)) throw new Error('Runtime mint or clock data is unavailable.');

const installed = await rpc('getAccountInfo', [programId.toBase58(), { encoding: 'base64' }]);
if (!installed.value?.executable) throw new Error('The agent-payments program is not installed.');
const configAddress = deriveAgentConfigAddress(programId);
const config = await rpc('getAccountInfo', [configAddress.toBase58(), { encoding: 'base64' }]);
if (!config.value || config.value.owner !== programId.toBase58() ||
    !decodeAgentConfig(decodeAccount(config.value)).equals(new PublicKey(info.mint))) {
  throw new Error('The host configuration does not pin the runtime XMR mint.');
}

const policyAccount = await rpc('getAccountInfo', [policyAddress.toBase58(), { encoding: 'base64' }]);
if (!policyAccount.value || policyAccount.value.owner !== programId.toBase58()) {
  throw new Error('The budget account is not owned by the configured program.');
}
const policy = decodeAgentPolicy(decodeAccount(policyAccount.value));
if (!deriveAgentBudgetAddress(programId, policy.id).equals(policyAddress)) {
  throw new Error('The selected budget address does not match the policy ID stored in its account.');
}
if (!agent.publicKey.equals(policy.agent)) throw new Error('This key is not the agent authorized by the selected budget.');
if (!policy.recipients.some((allowed) => allowed.equals(recipient))) throw new Error('Recipient is not authorized by the budget.');
if (policy.status !== 'active') throw new Error('The selected budget is no longer active.');
if (info.unixTime >= policy.expiresAt) throw new Error('The selected budget has expired.');
if (amount <= 0n || amount > policy.maxPayment) throw new Error('Payment exceeds the per-payment maximum.');
if (policy.spent + amount > policy.budget) throw new Error('Payment exceeds the remaining total budget.');

const receipt = deriveAgentReceiptAddress(programId, policyAddress, paymentId);
const existingReceipt = await rpc('getAccountInfo', [receipt.toBase58(), { encoding: 'base64' }]);
if (existingReceipt.value) {
  const stored = decodeAgentPaymentReceipt(decodeAccount(existingReceipt.value));
  if (!stored.policy.equals(policyAddress) || !Buffer.from(stored.paymentId).equals(Buffer.from(paymentId))) {
    throw new Error('Payment receipt address contains unexpected data; refusing to continue.');
  }
  throw new Error('This payment ID already has a permanent receipt. Do not retry it with a new ID.');
}

const mint = new PublicKey(info.mint);
const vault = deriveAssociatedTokenAddress(mint, policyAddress);
const recipientToken = deriveAssociatedTokenAddress(mint, recipient);
const payment = createAgentPaymentInstruction({
  programId, policy: policyAddress, agent: agent.publicKey, mint, vault, recipient,
  recipientToken, receipt, paymentId, amount,
});
const latest = await rpc('getLatestBlockhash');
const tx = new Transaction({
  feePayer: agent.publicKey,
  recentBlockhash: latest.value.blockhash,
}).add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 + Math.floor(Math.random() * 100_000) }),
  createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, recipientToken, recipient, mint),
  payment,
);
tx.sign(agent);

const signature = await rpc('sendTransaction', [
  tx.serialize().toString('base64'),
  { encoding: 'base64' },
]);
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const status = await rpc('getSignatureStatuses', [[signature]]);
  const value = status.value[0];
  if (value?.err) throw new Error(`Payment transaction failed: ${JSON.stringify(value.err)}`);
  if (value) {
    console.log(JSON.stringify({ signature, paymentId: Buffer.from(paymentId).toString('hex'), amount: amount.toString() }));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const afterTimeout = await rpc('getAccountInfo', [receipt.toBase58(), { encoding: 'base64' }]);
if (afterTimeout.value) {
  const stored = decodeAgentPaymentReceipt(decodeAccount(afterTimeout.value));
  if (stored.policy.equals(policyAddress) && Buffer.from(stored.paymentId).equals(Buffer.from(paymentId))) {
    throw new Error(`Payment receipt exists but confirmation timed out. Check transaction ${signature}; do not resubmit with a new ID.`);
  }
}
throw new Error(`Payment confirmation timed out for ${signature}. Check ledger status before retrying.`);
