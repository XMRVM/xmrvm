# XMRVM Launchpad — the on-chain program

This is the source of the program that runs the XMRVM token launchpad on mainnet: token creation,
the bonding curve, fees and graduation to Solana. It is the exact code behind program ID

```
8DkrVr2zewkS3u4Juh34hnKD2mVnY7sc8kU6aBgEJPoW
```

installed on the XMRVM runtime. Everything a token does on XMRVM — being created, bought, sold,
graduating — is an instruction of this program. There is no other token program: the tokens
themselves are standard SPL mints that this program creates and then locks.

## What it does

- **Create.** Mints a fixed supply of 1,000,000,000 tokens (6 decimals) into the curve's own vault
  and removes the mint authority in the same transaction, so no more can ever exist. Nobody gets an
  allocation — the creator buys like everyone else. The creator's Solana wallet is recorded in the
  curve state at creation and cannot be changed afterwards.
- **Buy / Sell.** A constant-product bonding curve (`x · y = k`) over virtual reserves, the same
  model as pump.fun. 793.1M tokens are sold on the curve; 206.9M are kept back.
- **Graduation.** When the last curve token is bought, trading on XMRVM stops for good. The 206.9M
  tokens and the collected XMR back a Raydium pool on Solana, opened by the XMRVM runtime at the
  curve's final price. No instruction can move those tokens out of a graduated vault.
- **Fees.** Every trade pays a creator fee and a protocol fee in XMR; half of the protocol fee goes
  to a buyback vault that only the runtime can move, to buy back and burn the XMRVM token on Solana.
  A fixed creation fee covers the real cost of graduating (Raydium pool fee, rent, swap spread).

All parameters are constants at the top of [`src/lib.rs`](./src/lib.rs):

| Constant | Value | Meaning |
|---|---|---|
| `TOTAL_SUPPLY` | 1,000,000,000 | fixed supply, 6 decimals |
| `INITIAL_REAL_TOKEN` | 793,100,000 | sold on the curve |
| `INITIAL_VIRTUAL_XMR` | 4.75 XMR | curve starting reserve |
| `INITIAL_VIRTUAL_TOKEN` | 1,073,000,000 | curve starting reserve |
| `CREATION_FEE` | 0.25 XMR | paid once by the creator |
| `CREATOR_FEE_BPS` | 30 | 0.30% per trade to the creator |
| `PROTOCOL_FEE_BPS` | 95 | 0.95% per trade to the platform |
| `BUYBACK_SHARE_BPS` | 5,000 | half of the protocol fee → buyback vault |

The curve sells out after roughly 13.46 XMR have been collected.

## What the platform can and cannot do

The platform authority is **not in this source**. It is compiled in at build time from the
`XMRVM_LAUNCHPAD_AUTHORITY` environment variable. It can do exactly two things: pause the creation of
*new* tokens, and claim the platform's half of the protocol fee. It cannot change any parameter,
move any curve's funds, touch the buyback vault, or stop trading on an existing token. The XMR of a
graduated token can be moved only by the XMRVM runtime, only into its own reserve, only once, to
fund the Solana pool.

## Building and verifying

Requires the Solana SBF toolchain (`cargo-build-sbf`, shipped with the Solana CLI).

```bash
XMRVM_LAUNCHPAD_AUTHORITY=<authority address> cargo-build-sbf
sha256sum target/deploy/xmrvm_launchpad.so
```

The authority address, and the SHA-256 of the deployed binary, are shown in the dApp under
**Verify TEE** (the runtime lists every installed program with its hash). Build with that authority
and compare: the hashes should match. The `staging*` Cargo features only rescale the curve for
rehearsals with little XMR and are not part of the mainnet build.

## Instruction layout

One selector byte, then little-endian operands; text fields are a length byte followed by UTF-8.
The full account lists are in the module documentation at the top of `src/lib.rs`.

| # | Instruction | Who signs |
|---|---|---|
| 0 | `Create { id, creator_wallet, name, symbol, description, website, x, telegram }` | creator |
| 1 | `Buy { max_xmr, min_tokens }` | trader |
| 2 | `Sell { tokens, min_xmr }` | trader |
| 3 | `ClaimCreatorFees` | creator |
| 4 | `ClaimProtocolFees` | platform authority |
| 5 | `SetPaused { paused }` | platform authority |
| 6 | `ClaimMigrationXmr` | XMRVM runtime (graduated token, once) |
| 7 | `ClaimBuybackXmr` | XMRVM runtime |

## License

MIT.
