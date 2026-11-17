import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../src/escrow-client.js';
import {
  AGENT_CONFIG_SIZE, AGENT_POLICY_SIZE, AGENT_RECEIPT_SIZE, AGENT_RECEIPT_STATUS,
  createAgentBudgetInstruction, createAgentPaymentInstruction, createReclaimExpiredAgentBudgetInstruction,
  createRevokeAgentBudgetInstruction, decodeAgentConfig, decodeAgentPaymentReceipt, decodeAgentPolicy,
  deriveAgentBudgetAddress, deriveAgentConfigAddress, deriveAgentReceiptAddress, explainAgentPaymentError,
} from '../src/agent-payments-client.js';

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));

test('agent budget instruction matches the policy ABI and rejects invalid policies', () => {
  const programId = key(1);
  const owner = key(2);
  const agent = key(3);
  const recipient = key(4);
  const id = new Uint8Array(32).fill(5);
  const policy = deriveAgentBudgetAddress(programId, id);
  const instruction = createAgentBudgetInstruction({
    programId, policy, owner, agent, mint: key(6), ownerToken: key(7), vault: key(8),
    config: deriveAgentConfigAddress(programId), id, budget: 1200n, maxPayment: 500n,
    expiresAt: 2_000_000_000, recipients: [recipient],
  });

  assert.equal(instruction.data.length, 90);
  assert.equal(instruction.data[0], 0);
  assert.deepEqual(Array.from(instruction.data.slice(1, 33)), Array.from(id));
  const view = new DataView(instruction.data.buffer, instruction.data.byteOffset, instruction.data.byteLength);
  assert.equal(view.getBigUint64(33, true), 1200n);
  assert.equal(view.getBigUint64(41, true), 500n);
  assert.equal(view.getBigInt64(49, true), 2_000_000_000n);
  assert.equal(instruction.data[57], 1);
  assert.deepEqual(instruction.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable]), [
    [false, true], [true, true], [false, true], [false, false], [false, true],
    [false, true], [false, false], [false, false], [false, false],
  ]);
  assert.equal(instruction.keys[7]!.pubkey.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(instruction.keys[8]!.pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.throws(() => createAgentBudgetInstruction({
    programId, policy, owner, agent, mint: key(6), ownerToken: key(7), vault: key(8),
    config: deriveAgentConfigAddress(programId), id, budget: 100n, maxPayment: 101n,
    expiresAt: 2_000_000_000, recipients: [recipient],
  }), /no greater than the budget/);
  assert.throws(() => createAgentBudgetInstruction({
    programId, policy, owner, agent, mint: key(6), ownerToken: key(7), vault: key(8),
    config: deriveAgentConfigAddress(programId), id, budget: 100n, maxPayment: 50n,
    expiresAt: 2_000_000_000, recipients: [recipient, recipient],
  }), /distinct/);
});

test('payment, revoke, and expired-reclaim builders use the program selectors and account roles', () => {
  const programId = key(1);
  const policy = key(2);
  const agent = key(3);
  const mint = key(4);
  const vault = key(5);
  const recipient = key(6);
  const recipientToken = key(7);
  const paymentId = new Uint8Array(32).fill(8);
  const receipt = deriveAgentReceiptAddress(programId, policy, paymentId);
  const payment = createAgentPaymentInstruction({
    programId, policy, agent, mint, vault, recipient, recipientToken, receipt, paymentId, amount: 99n,
  });
  assert.equal(payment.data.length, 41);
  assert.equal(payment.data[0], 1);
  assert.deepEqual(Array.from(payment.data.slice(1, 33)), Array.from(paymentId));
  assert.equal(new DataView(payment.data.buffer, payment.data.byteOffset).getBigUint64(33, true), 99n);
  assert.equal(payment.keys[1]!.isSigner, true);
  assert.equal(payment.keys[8]!.pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());

  const common = { programId, policy, mint, vault, ownerToken: key(9) };
  const revoked = createRevokeAgentBudgetInstruction({ ...common, owner: key(10) });
  const reclaimed = createReclaimExpiredAgentBudgetInstruction({ ...common, caller: key(11) });
  assert.deepEqual([...revoked.data], [2]);
  assert.deepEqual([...reclaimed.data], [3]);
  assert.equal(reclaimed.keys[1]!.pubkey.toBase58(), key(11).toBase58());
});

test('agent config, policy and payment receipt decoders validate their fixed layouts', () => {
  const config = new Uint8Array(AGENT_CONFIG_SIZE);
  config[0] = 1;
  config.set(key(1).toBytes(), 1);
  assert.equal(decodeAgentConfig(config).toBase58(), key(1).toBase58());
  assert.throws(() => decodeAgentConfig(config.slice(1)), /config account/);

  const policy = new Uint8Array(AGENT_POLICY_SIZE);
  const owner = key(2);
  const agent = key(3);
  const mint = key(4);
  const recipient = key(5);
  policy[0] = AGENT_RECEIPT_STATUS.active;
  policy[1] = 255;
  policy[2] = 1;
  policy.set(new Uint8Array(32).fill(6), 4);
  policy.set(owner.toBytes(), 36);
  policy.set(agent.toBytes(), 68);
  policy.set(mint.toBytes(), 100);
  const policyView = new DataView(policy.buffer);
  policyView.setBigUint64(132, 1000n, true);
  policyView.setBigUint64(140, 400n, true);
  policyView.setBigUint64(148, 100n, true);
  policyView.setBigInt64(156, 2_000_000_100n, true);
  policyView.setBigInt64(164, 2_000_000_000n, true);
  policy.set(recipient.toBytes(), 172);
  const decodedPolicy = decodeAgentPolicy(policy);
  assert.equal(decodedPolicy.status, 'active');
  assert.equal(decodedPolicy.spent, 100n);
  assert.equal(decodedPolicy.recipients[0]!.toBase58(), recipient.toBase58());
  policy[3] = 1;
  assert.throws(() => decodeAgentPolicy(policy), /policy account/);

  const receipt = new Uint8Array(AGENT_RECEIPT_SIZE);
  receipt[0] = 1;
  receipt[1] = 255;
  receipt.set(key(7).toBytes(), 2);
  receipt.set(new Uint8Array(32).fill(8), 34);
  receipt.set(recipient.toBytes(), 66);
  const receiptView = new DataView(receipt.buffer);
  receiptView.setBigUint64(98, 99n, true);
  receiptView.setBigInt64(106, 2_000_000_050n, true);
  const decodedReceipt = decodeAgentPaymentReceipt(receipt);
  assert.equal(decodedReceipt.amount, 99n);
  assert.equal(decodedReceipt.recipient.toBase58(), recipient.toBase58());
  assert.throws(() => decodeAgentPaymentReceipt(receipt.slice(1)), /receipt account/);
});

test('agent PDA derivations are stable and custom errors map to safe explanations', () => {
  const programId = key(1);
  const policy = key(2);
  const id = new Uint8Array(32).fill(3);
  assert.equal(deriveAgentBudgetAddress(programId, id).toBase58(), deriveAgentBudgetAddress(programId, id).toBase58());
  assert.equal(deriveAgentReceiptAddress(programId, policy, id).toBase58(), deriveAgentReceiptAddress(programId, policy, id).toBase58());
  assert.throws(() => deriveAgentBudgetAddress(programId, new Uint8Array(31)), /32 bytes/);
  assert.match(explainAgentPaymentError('custom program error: 0x10') ?? '', /per-payment limit/);
  assert.equal(explainAgentPaymentError('network timeout'), null);
});
