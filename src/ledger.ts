export type MoneroNetwork = 'mainnet' | 'stagenet';

export interface MoneroDepositAddress {
  account: string;
  address: string;
  major: number;
  minor: number;
}

export interface VerifiedMoneroDeposit {
  txid: string;
  major: number;
  minor: number;
  account: string;
  amount: string;
  height: number;
  confirmations: number;
}

export type WithdrawalState = 'RESERVED' | 'SIGNING' | 'SIGNED' | 'SUBMISSION_UNKNOWN' |
  'SUBMITTED' | 'PAUSED_RECONCILIATION' | 'SETTLED_POLICY' | 'CANCELLED_PRE_SIGN';

export interface Withdrawal {
  id: string;
  owner: string;
  destination: string;
  principal: string;
  feeBudget: string;
  state: WithdrawalState;
  artifact: string | null;
  actualFee: string | null;
  transactionHash: string;
  moneroTxHash?: string | null;
  signedTxBlob?: string | null;
}

export interface BridgeStatus {
  state: 'ACTIVE' | 'RECONCILIATION_REQUIRED';
  reason: string | null;
}

export interface VerifiedMoneroWithdrawalView {
  txid: string;
  amount: string;
  fee: string;
  type: 'out' | 'pending';
  doubleSpendSeen: boolean;
}

export interface LedgerInfo {
  accounting: { R: string; L: string; W: string; F: string };
  [key: string]: unknown;
}

/**
 * What the Monero bridge needs from an execution ledger. Implemented by the SVM runtime
 * (Solana pubkeys, SPL mint, 1 XMR = 1e12 units). Everything Monero-specific lives in the
 * bridge; everything VM-specific lives behind this interface.
 */
export interface LedgerRuntime {
  /** How many ledger base units one piconero (1e-12 XMR) represents. */
  readonly unitsPerPiconero: bigint;
  /** Canonicalize an account identifier or throw an InputError. */
  normalizeAccount(account: string): string;
  /** Text the account owner must sign to obtain a deposit address. */
  depositAddressMessage(account: string, network?: MoneroNetwork): string;
  /** Verify a wallet signature over `message` by `account`. */
  verifyAccountSignature(account: string, message: string, signature: string): Promise<boolean>;

  depositAddress(account: string, create: () => Promise<Omit<MoneroDepositAddress, 'account'>>): Promise<MoneroDepositAddress>;
  depositAddresses(): Promise<MoneroDepositAddress[]>;
  moneroDeposits(): Promise<Array<{ id: string; txid: string; major: number; minor: number; amount: string; height: number; confirmations: number }>>;
  creditMoneroDeposit(deposit: VerifiedMoneroDeposit): Promise<{ replay: boolean }>;

  moneroBridgeStatus(): Promise<BridgeStatus>;
  haltMoneroBridge(reason: string): Promise<BridgeStatus>;
  cancelMoneroWithdrawalAfterDefinitiveSigningFailure(id: string): Promise<Withdrawal>;
  resumeMoneroBridgeAfterVerifiedWithdrawal(id: string, transfer: VerifiedMoneroWithdrawalView): Promise<void>;

  pendingWithdrawals(): Promise<Withdrawal[]>;
  beginMoneroWithdrawal(id: string): Promise<Withdrawal>;
  recordMoneroWithdrawalSignature(id: string, txHash: string, txBlob: string, fee: string): Promise<Withdrawal>;
  markMoneroWithdrawalUnknown(id: string): Promise<Withdrawal>;
  markMoneroWithdrawalSubmitted(id: string, txHash: string): Promise<Withdrawal>;
  transitionWithdrawal(id: string, action: string, value?: string): Promise<Withdrawal>;
  withdrawal(id: string): Promise<Withdrawal | null>;

  info(): Promise<LedgerInfo>;
  assertStagenetLedger(): Promise<void>;
  close(): Promise<void>;
}
