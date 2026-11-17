# XMRVM Agent Payments

A self-contained developer client and external signer example for XMRVM Agent
Payments. This directory has its own dependency manifest and build configuration;
it does not depend on files in the parent repository, launchpad, or runtime.

The agent spends from a user-funded XMRVM budget with approved recipients, a
per-payment maximum, a total budget, and an expiry. The owner can revoke the
authorization and recover the unspent balance.

Payments credit XMRVM accounts, not arbitrary Monero addresses. This is not a
hosted AI bot or a published npm SDK: developers connect their bot's payment tool
to the client, while the XMRVM program enforces the spending rules.

## How the dApp and code work together

- **Owner:** uses the [live dApp](https://www.xmrvm.net/app.html#agent-payments)
  to fund, inspect, and revoke budgets with their own wallet.
- **Agent:** runs this Node.js client on their own computer or server and signs
  payments with a separate agent key.
- **Recipient:** receives the payment in their XMRVM account and can use the dApp
  to check the balance or request a Monero withdrawal through the normal flow.

The owner's browser does not need to remain open for an authorized agent to pay.
The agent process must be running when it requests a payment; this script sends
one payment and exits rather than running a background scheduler.

## Package layout

Upload the entire `agent-payments` directory at the root of the GitHub repository.
Keep its nested paths. Do not merge its files into the repository's existing
root `src`, `programs`, or launchpad directories.

```text
agent-payments/
  .gitignore
  LICENSE
  README.md
  package.json
  package-lock.json
  tsconfig.json
  src/
    agent-payments-client.ts
    escrow-client.ts
  test/
    agent-payments-client.test.ts
  examples/agent-payments/
    pay.mjs
  programs/agent-payments/
    Cargo.toml
    Cargo.lock
    src/lib.rs
```

Never upload keys, environment files, node_modules, dist, target, or runtime
state. The program source is provided for inspection; the client commands below
do not compile Rust, deploy programs, or restart the TEE.

## 1. Install on your computer or server

Requirements: Node.js 24 or newer, npm, and Git. The commands below use Bash
(Linux, macOS, or WSL). No access to the operator's VPS is needed.
Use a separate checkout, not a live deployment directory:

```bash
git clone https://github.com/XMRVM/xmrvm.git "$HOME/xmrvm-agent-client"
cd "$HOME/xmrvm-agent-client/agent-payments"
node -v
npm ci
npm test
```

Stop if any command fails. Do not run `npm init` or replace the manifest. Four
client tests should pass. These validate instruction encoding and account
decoding, not a mainnet end-to-end payment. The runtime and LiteSVM are not
dependencies of this package.

## 2. Create a dedicated agent key

In the same terminal, inside this directory:

```bash
umask 077
mkdir -p "$HOME/.config/xmrvm"
chmod 700 "$HOME/.config/xmrvm"
export XMRVM_AGENT_KEYPAIR_PATH="$HOME/.config/xmrvm/agent-keypair.json"
node -e 'const fs=require("node:fs"); const {Keypair}=require("@solana/web3.js"); const k=Keypair.generate(); fs.writeFileSync(process.env.XMRVM_AGENT_KEYPAIR_PATH,JSON.stringify(Array.from(k.secretKey)),{flag:"wx",mode:0o600}); console.log("Agent public address:",k.publicKey.toBase58())'
```

Only the public address is printed. The command refuses to overwrite an existing
key. Keep the key outside the checkout and never show it in a video, prompt, or
log. The computer or server running the agent holds only this agent key, not
the owner's wallet key.

## 3. Create the budget in the real dApp

1. In a separate browser profile, connect a second wallet to the XMRVM dApp.
   Unlock its XMRVM account, request its deposit address, and copy its XMRVM
   account address. Do not use the Monero deposit address as the recipient.
   No XMR deposit is needed for this recipient setup.
2. Record the recipient's current internal XMR balance.
3. In the main browser, connect the funded owner wallet and open Agent Payments.
   Check for `Program verified` and record the owner's balance.
4. Enter the agent public address printed by the command above.
5. Add the second XMRVM account as the authorized recipient. Owner, agent, and
   recipient must be different.
6. For example, fund `0.001` XMR, set a per-payment maximum of `0.0002` XMR,
   and choose a future expiry that leaves time to finish.
7. Review and authorize, then copy the budget address from its card.

This uses real XMR-backed balances on mainnet. The budget moves from the owner's
existing internal balance, without another Monero deposit. Budget creation also
supplies the agent with internal, non-XMR compute credits.

## 4. Connect to the public RPC and configure one payment

Use the public HTTPS RPC from the official dApp configuration. The endpoint
below is the currently configured public endpoint; if it changes, obtain the
new value from the official site rather than an untrusted message.

Users do not start an RPC server, open inbound ports, SSH into the operator's
VPS, or install a TEE. Their agent makes outbound HTTPS requests to the existing
gateway, which forwards transactions to the TEE.

```bash
export XMRVM_RPC_URL='https://146.70.86.22/rpc'
export XMRVM_AGENT_PAYMENTS_PROGRAM_ID='GJ1g25AwfJDNAWDnk26aHr1TPcpgpLpHWbCX5VNNkUKw'
read -r -p 'Budget address: ' XMRVM_BUDGET_ADDRESS
read -r -p 'Authorized recipient XMRVM address: ' XMRVM_RECIPIENT
export XMRVM_BUDGET_ADDRESS XMRVM_RECIPIENT
export XMRVM_PAYMENT_ID="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
printf 'Keep this payment ID: %s\n' "$XMRVM_PAYMENT_ID"
```

Generate that payment ID only once for this operation. Keep the terminal open
and preserve the ID. Never generate a new ID simply because a request timed out.

The example supplies `Origin: https://www.xmrvm.net` because the current gateway
requires an allowed Origin header, including for non-browser clients. For a
different deployment, set `XMRVM_RPC_ORIGIN` to its allowed origin. This header
is a routing/access-policy requirement, not proof of identity: payment authority
comes from the agent's transaction signature.

Only the operator testing directly on the VPS can instead use
`http://127.0.0.1:18545`. For everyone else, `127.0.0.1` means their own machine,
not the XMRVM service. Do not expose port 18545, the Monero wallet RPC, or operator
tokens publicly. Keep normal HTTPS certificate verification enabled.

## 5. Check the limit, then pay

First request more than the per-payment maximum:

```bash
export XMRVM_PAYMENT_AMOUNT='0.0003'
npm run pay
```

The client should refuse with `Payment exceeds the per-payment maximum.` This
is a local preflight check, not an on-ledger enforcement test.

Then submit one real payment:

```bash
export XMRVM_PAYMENT_AMOUNT='0.0001'
npm run pay
```

A confirmed result prints a transaction signature, payment ID, and amount in
piconero: `100000000` for `0.0001` XMR. If confirmation is uncertain, inspect
the receipt and transaction before attempting another submission.

## 6. Verify payment, duplicate protection, and revocation

1. Refresh the owner's budget card. Check that spent is `0.0001` XMR and the
   remaining budget is `0.0009` XMR.
2. Expand the receipts and match the recipient, amount, and payment ID.
3. Refresh the recipient's balance: it must have increased by `0.0001` XMR.
4. Run `npm run pay` again without changing the environment. The client should
   refuse the already-used payment ID. Confirm that there is still one payment.
5. Revoke the budget in the owner's dApp. Confirm that `0.0009` XMR returns to
   the owner and the budget is marked revoked.
6. Run `npm run pay` again. The client should refuse the inactive budget.

The duplicate and revoked-budget commands above exercise client preflight
checks. They do not independently prove runtime rejection of crafted invalid
transactions. The Rust source implements those rules, but runtime integration
tests are separate from the four client tests included here.

## 7. Connect a bot

The developer connects the bot's payment tool to these instruction builders and
an external signer using the dedicated agent key. Each business operation needs
a durable, stable payment ID, budget address, recipient, and amount. The key must
stay in the signing process or key manager, never in the model's prompt.

The script validates program/configuration, policy, authorized agent, recipient,
expiry, and limits before signing. It does not automatically resubmit payments.
A receipt prevents another charge with the same ID, not duplicate business
operations assigned different IDs. Only report settlement after confirmation.

For a new business operation, set its recipient, amount and a new durable payment
ID before invoking `npm run pay` from your bot's backend. Keep the same ID for
retries of that operation. Do not interpolate model-generated text into shell
commands; validate tool arguments and pass them as structured process
environment values or use the TypeScript builders directly.

If you open a new terminal, set the environment variables again, including
`XMRVM_AGENT_KEYPAIR_PATH`, using the existing key file. Do not create another
key for a budget authorized to the first one.

For a video, show the owner funding a budget, the VPS sending a payment, the
receipt, recipient balance, duplicate rejection, and revocation/refund. This
demonstrates an external signer, not an AI model deciding autonomously to pay.

## License

[MIT](./LICENSE).
