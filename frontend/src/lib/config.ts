export const NETWORK = 'testnet' as const

export const ALGOD_CONFIG = {
  baseServer: 'https://testnet-api.algonode.cloud',
  port: '',
  token: '',
}

export const INDEXER_CONFIG = {
  baseServer: 'https://testnet-idx.algonode.cloud',
  port: '',
  token: '',
}

const DEFAULT_POOL_APP_ID = 756420132
const DEFAULT_POOL_APP_ADDRESS = 'O3I26T6EZ2UCCSWHQGMD6R5XJUX2AK3DU5I7S76M2SA2AE63IFZFUMPKEU'

function getPoolConfig() {
  const storedId = localStorage.getItem('privacy_pool_app_id')
  const storedAddr = localStorage.getItem('privacy_pool_app_address')
  if (storedId && storedAddr) {
    return { appId: parseInt(storedId, 10), appAddress: storedAddr }
  }
  return { appId: DEFAULT_POOL_APP_ID, appAddress: DEFAULT_POOL_APP_ADDRESS }
}

export const CONTRACTS = {
  StealthRegistry: {
    appId: 756386179,
    appAddress: 'NIRHYSPNJHSHLQ3DKKMG7BGXM6L4FXATD4W6NGXO7MPQSA32YC6FFLO5FQ',
  },
  get PrivacyPool() { return getPoolConfig() },
  ShieldedPool: {
    appId: 756386192,
    appAddress: 'PTTTWTO7OYNAKWE3IEBBY7D734IPD47QAOHNXR4BIP5PAKVUKTAVW6NOS4',
  },
  ConfidentialAsset: {
    appId: 756386193,
    appAddress: 'CH7INM5MMOLMB4ZYXVD7LVA2U3WS7CEPUMVCRXTFO4UVOP4T4X3X5AZ43Y',
  },
  ZkVerifier: {
    appId: 756420114,
    budgetHelperAppId: 756420102,
  },
  DepositVerifier: {
    appId: 756420115,
    budgetHelperAppId: 756420102,
  },
  PrivateSendVerifier: {
    appId: 756420116,
    budgetHelperAppId: 756420102,
  },
} as const

// Fixed denomination tiers (microAlgos)
export const DENOMINATION_TIERS = [
  { label: '0.1', microAlgos: 100_000n },
  { label: '0.5', microAlgos: 500_000n },
  { label: '1.0', microAlgos: 1_000_000n },
] as const

export type DenominationTier = (typeof DENOMINATION_TIERS)[number]

/** Check if a microAlgo amount is a valid tier */
export function isValidTier(microAlgos: bigint): boolean {
  return DENOMINATION_TIERS.some(t => t.microAlgos === microAlgos)
}

// Default denomination: 1 ALGO = 1_000_000 microAlgos
export const POOL_DENOMINATION = 1_000_000n

// Per-denomination pool contracts
export const POOL_CONTRACTS: Record<string, { appId: number; appAddress: string }> = {
  '100000': { appId: 756420118, appAddress: 'DOIY26VVBDURORVRC52UHGXUFCZ2FB725T3YNDJJOIM2BQTQFDGO75XBTQ' },
  '500000': { appId: 756420130, appAddress: 'W2IBUIN32FL7JIHTDVDFDVG6F4HHWP4X2CJRDVFBKC6Y7MVJ22INRVGEIY' },
  '1000000': { appId: 756420132, appAddress: 'O3I26T6EZ2UCCSWHQGMD6R5XJUX2AK3DU5I7S76M2SA2AE63IFZFUMPKEU' },
}

/** Get pool config for a specific tier (microAlgos) */
export function getPoolForTier(microAlgos: bigint): { appId: number; appAddress: string } {
  const pool = POOL_CONTRACTS[microAlgos.toString()]
  if (!pool) throw new Error(`No pool configured for denomination ${microAlgos} microAlgos`)
  return pool
}

// Relayer configuration (set RELAYER_URL to enable relayed withdrawals)
export const RELAYER_URL = 'https://privacy-pool-relayer.mitchhall16.workers.dev'
export const RELAYER_ADDRESS = 'MCH3ZDYI6NEP2EFGZVLOH7BZH6ZEUYBZWERNJT7JGYK4GMUJDL6TLHZTIA'
export const RELAYER_FEE = 250_000n // 0.25 ALGO — covers verifier gas + margin

// Fee estimates (in microAlgos) — network fees paid by sender, not deducted from transfer
export const FEES = {
  deposit: 206_000n,              // deposit verifier (~202 inner calls) + payment (0.001) + pool app call (0.002)
  withdraw: 215_000n,             // withdraw verifier (~211 inner calls) + pool app call (0.002)
  privateSend: 226_000n,          // combined verifier (~221 inner calls) + payment + pool app call
  verifierCall: 203_000n,         // deposit verifier flat fee
  withdrawVerifierCall: 213_000n, // withdraw verifier flat fee
  privateSendVerifierCall: 223_000n, // combined verifier flat fee
  minBalance: 100_000n,
}

export const EXPLORER_BASE = 'https://testnet.explorer.perawallet.app'

export function txnUrl(txId: string): string {
  return `${EXPLORER_BASE}/tx/${txId}`
}

export function addrUrl(addr: string): string {
  return `${EXPLORER_BASE}/address/${addr}`
}
