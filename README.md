<p align="center">
  <img src="./logo.jpeg" alt="XMRVM" width="140">
</p>

# XMRVM — a privacy-oriented contract execution platform centered on XMR

XMRVM is a general-purpose contract execution platform in which Solana programs run with persistent
state inside a hardware-protected runtime, while deposits and withdrawals settle natively on Monero.
Monero validates the native deposits and withdrawals; the programs themselves execute in the XMRVM
runtime, under its own state, ordering and key-management model.

The execution engine is the **Solana VM** (SVM, via LiteSVM), so the existing Solana developer
ecosystem applies directly:

| | |
|---|---|
| **Wallets and tooling** | Phantom, `@solana/web3.js`, `@solana/kit`, Anchor |
| **Account identity** | base58 pubkey |
| **XMR unit** | SPL mint, 12 decimals (1 unit = 1 piconero) |
| **Interface** | standard Solana JSON-RPC |

The working name does not imply endorsement by the Monero project or the Solana project, nor the
existence of a Monero-native virtual machine.

## How it works

XMRVM is built in three layers.

**Monero — native settlement and reserves.** Users deposit real XMR to a per-account subaddress.
After the required confirmation policy, the runtime credits the corresponding internal account or
program. Withdrawals consume an internal entitlement and settle as a native Monero payment. Monero
does not see each internal swap, loan, vote or token transfer — it sees deposits and withdrawals.

**XMRVM — execution, state and accounting.** The runtime deploys and executes developer programs,
verifies transaction signatures, meters resource consumption, maintains accounts and program state,
executes multi-instruction transactions atomically, and records ordered state transitions. The
account state is committed atomically to durable storage together with the reserve ledger, so
execution and reserve accounting can never diverge across a restart.

**TEE — protection and attestation.** The runtime and `monero-wallet-rpc` execute inside a hardware
enclave on Marlin Oyster. The enclave image is built reproducibly from pinned sources, its
measurements are published, and remote attestation binds those measurements to the running instance,
so what holds the reserve keys is the code that was published. The JSON-RPC endpoint stays bound to
loopback inside the enclave and is reached only through an authenticated reverse tunnel.

## Architecture in one picture

```text
Web UI -> HTTPS gateway (VPS) -> SSH reverse tunnel -> XMRVM runtime + monero-wallet-rpc (TEE enclave)
                 |                                              |
                 |                     local SSH forward <- monerod (Monero node on the VPS)
                 |
                 +-- deployment wallet, used only to pay for enclave jobs
```

The Monero node runs on the VPS rather than inside the enclave: enclave storage is ephemeral and far
smaller than the Monero chain. The enclave reaches it through a local forward on the same
authenticated tunnel. This boundary, and what it means for the trust model, is documented explicitly
in the technical documentation.

## Implementation

The execution and settlement layers are implemented:

- A standard **Solana JSON-RPC** interface (account, balance, block, transaction, token and
  simulation methods), so Phantom and the usual Solana client libraries connect to it as a custom
  endpoint.
- Developer deployment of compiled **SBF programs**, including Anchor programs.
- XMR represented as an **SPL mint with 12 decimals**, where one unit is exactly one piconero, with
  associated token accounts and standard SPL transfers between accounts and programs.
- Transaction verification against the runtime's own genesis hash and blockhash lifetime, with
  size limits and replay handling.
- A Monero bridge that binds accounts to wallet subaddresses, credits only confirmed incoming
  transfers, and processes authorized payouts with a persisted signed transaction artifact.
- Withdrawals requested on-chain through a memo instruction carrying the destination address and a
  fee budget, with pending encumbrances, fee-budget checks, fee refunds and settlement replay
  handling.
- Continuously checked reserve accounting across reserves, liabilities, pending withdrawals and the
  fee reserve, persisted atomically with the runtime snapshot.
- Recovery behaviour for uncertain submission, chain-view inconsistencies, interrupted signing and
  post-settlement confirmation loss.

**The Stagenet deposit-to-payout flow has been exercised end-to-end**: real Stagenet XMR deposited to
a per-account subaddress, credited inside the VM as SPL units, moved by signed Solana transactions,
and paid back out as a native Monero transaction.

## What this repository contains

This repository documents the architecture of XMRVM and publishes the dApp front-end. The runtime
service, the enclave image definition and the deployment automation are not published here yet.

| Path | Contents |
|---|---|
| [docs/](./docs) | Whitepaper, project description, technical specification, privacy policy and operational guides |


## Documentation

Start here:

1. **[Whitepaper](./docs/xmrvm-tee-whitepaper.md)** — the architecture, threat model and rationale.




## Project status

This repository is the canonical source for XMRVM's architecture and reference implementation. There
is no public endpoint and no hosted dApp: anything presenting itself as an official XMRVM deposit
service is not associated with this project. Follow this repository for deployment announcements.

## Contributing

Issues and discussion about the design are welcome. Because the runtime is not published here yet,
please do not open pull requests against code that is not in this repository.

## License

[MIT](./LICENSE).
