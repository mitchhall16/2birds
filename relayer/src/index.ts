/**
 * Privacy Pool Relayer — Cloudflare Worker
 *
 * Submits withdrawal transactions on behalf of users so the on-chain sender
 * is the relayer address, not the user's wallet (preserving withdrawal privacy).
 *
 * POST /api/withdraw
 * Body: { proof: string, signals: string, poolAppId: number, nullifierHash: string, root: string }
 *   proof: hex-encoded 256-byte Groth16 proof
 *   signals: hex-encoded 192-byte public signals
 *   poolAppId: the privacy pool app ID
 *   nullifierHash: hex-encoded 32-byte nullifier hash
 *   root: hex-encoded 32-byte Merkle root
 */

import algosdk from 'algosdk'

interface Env {
  RELAYER_MNEMONIC: string
  ALGOD_URL: string
  VERIFIER_APP_ID?: string
  BUDGET_HELPER_APP_ID?: string
  ALLOWED_POOL_IDS?: string // comma-separated list of allowed pool app IDs
  ALLOWED_ORIGINS?: string // comma-separated list of allowed CORS origins
}

const MIN_RELAY_FEE = 200_000 // 0.2 ALGO minimum to cover relayer costs

interface WithdrawRequest {
  proof: string
  signals: string
  poolAppId: number
  nullifierHash: string
  root: string
  recipient: string
  relayerAddress: string
  fee: number
}

// ARC-4 method selector for withdraw(byte[],address,address,uint64,byte[],byte[],byte[])void
const WITHDRAW_SELECTOR = new Uint8Array([0x1b, 0xd9, 0xeb, 0x9c])

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return bytes
}

function uint64ToBytes(n: bigint | number): Uint8Array {
  const buf = new Uint8Array(8)
  let val = typeof n === 'number' ? BigInt(n) : n
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(val & 0xffn)
    val >>= 8n
  }
  return buf
}

function abiEncodeBytes(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(2 + data.length)
  result[0] = (data.length >> 8) & 0xff
  result[1] = data.length & 0xff
  result.set(data, 2)
  return result
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Convert an Algorand address public key to a BN254 scalar (32-byte big-endian) */
function addressToSignalBytes(addr: string): Uint8Array {
  const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
  const pubKey = algosdk.decodeAddress(addr).publicKey
  let n = 0n
  for (let i = 0; i < pubKey.length; i++) {
    n = (n << 8n) | BigInt(pubKey[i])
  }
  n = n % BN254_R
  const buf = new Uint8Array(32)
  let val = n
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(val & 0xffn)
    val >>= 8n
  }
  return buf
}

function corsHeaders(env: Env, request?: Request): HeadersInit {
  let origin = '*'
  if (env.ALLOWED_ORIGINS) {
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    const reqOrigin = request?.headers.get('Origin') ?? ''
    origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0]
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function jsonResponse(data: object, status: number, env: Env, request?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request) },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) })
    }

    const url = new URL(request.url)

    if (url.pathname === '/api/withdraw' && request.method === 'POST') {
      return handleWithdraw(request, env)
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok' }, 200, env, request)
    }

    return jsonResponse({ error: 'Not found' }, 404, env, request)
  },
}

async function handleWithdraw(request: Request, env: Env): Promise<Response> {
  const json = (data: object, status = 200) => jsonResponse(data, status, env, request)

  if (!env.RELAYER_MNEMONIC) {
    return json({ error: 'Relayer not configured' }, 500)
  }

  let body: WithdrawRequest
  try {
    body = await request.json() as WithdrawRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  // Validate required fields
  if (!body.proof || !body.signals || !body.poolAppId || !body.nullifierHash || !body.root || !body.recipient) {
    return json({ error: 'Missing required fields: proof, signals, poolAppId, nullifierHash, root, recipient' }, 400)
  }

  // Validate pool is in allowlist
  if (env.ALLOWED_POOL_IDS) {
    const allowed = new Set(env.ALLOWED_POOL_IDS.split(',').map(s => parseInt(s.trim(), 10)))
    if (!allowed.has(body.poolAppId)) {
      return json({ error: 'Pool app ID not in allowlist' }, 403)
    }
  }

  // Validate relay fee covers costs
  const relayFee = body.fee ?? 0
  if (relayFee < MIN_RELAY_FEE) {
    return json({ error: `Relay fee must be at least ${MIN_RELAY_FEE} microAlgos (${MIN_RELAY_FEE / 1_000_000} ALGO)` }, 400)
  }

  // Validate hex format and lengths
  const proofBytes = hexToBytes(body.proof)
  const signalsBytes = hexToBytes(body.signals)
  const nullifierHashBytes = hexToBytes(body.nullifierHash)
  const rootBytes = hexToBytes(body.root)

  if (proofBytes.length !== 256) return json({ error: 'proof must be 256 bytes' }, 400)
  if (signalsBytes.length !== 192) return json({ error: 'signals must be 192 bytes' }, 400)
  if (nullifierHashBytes.length !== 32) return json({ error: 'nullifierHash must be 32 bytes' }, 400)
  if (rootBytes.length !== 32) return json({ error: 'root must be 32 bytes' }, 400)

  if (!algosdk.isValidAddress(body.recipient)) {
    return json({ error: 'Invalid recipient address' }, 400)
  }

  // Verify signals encode the claimed parameters (prevents proof replay for different recipient)
  const recipientSignal = addressToSignalBytes(body.recipient)
  if (!bytesEqual(signalsBytes.slice(64, 96), recipientSignal)) {
    return json({ error: 'Signals recipient does not match request recipient' }, 400)
  }
  if (!bytesEqual(signalsBytes.slice(0, 32), rootBytes)) {
    return json({ error: 'Signals root does not match request root' }, 400)
  }
  if (!bytesEqual(signalsBytes.slice(32, 64), nullifierHashBytes)) {
    return json({ error: 'Signals nullifierHash does not match request nullifierHash' }, 400)
  }
  // Verify fee in signals matches request fee
  const signalFeeBytes = signalsBytes.slice(128, 160)
  const expectedFeeBytes = new Uint8Array(32)
  expectedFeeBytes.set(uint64ToBytes(BigInt(relayFee)), 24) // 24 zero bytes + 8-byte uint64
  if (!bytesEqual(signalFeeBytes, expectedFeeBytes)) {
    return json({ error: 'Signals fee does not match request fee' }, 400)
  }

  try {
    const algod = new algosdk.Algodv2('', env.ALGOD_URL)
    const relayer = algosdk.mnemonicToSecretKey(env.RELAYER_MNEMONIC)

    // Verify relayer signal matches this relayer's address
    const relayerSignal = addressToSignalBytes(relayer.addr)
    if (!bytesEqual(signalsBytes.slice(96, 128), relayerSignal)) {
      return json({ error: 'Signals relayer does not match this relayer address' }, 400)
    }

    // Check nullifier isn't already spent
    const nullBoxName = new Uint8Array(4 + 32)
    nullBoxName.set(new TextEncoder().encode('null'), 0)
    nullBoxName.set(nullifierHashBytes, 4)
    try {
      await algod.getApplicationBoxByName(body.poolAppId, nullBoxName).do()
      return json({ error: 'Nullifier already spent' }, 409)
    } catch {
      // Expected — not spent yet
    }

    const verifierAppId = env.VERIFIER_APP_ID ? parseInt(env.VERIFIER_APP_ID) : 0
    const budgetHelperAppId = env.BUDGET_HELPER_APP_ID ? parseInt(env.BUDGET_HELPER_APP_ID) : 0

    if (!verifierAppId) {
      return json({ error: 'Verifier app not configured' }, 500)
    }

    const params = await algod.getTransactionParams().do()

    // [0] ZK verifier app call
    const verifierAppCall = algosdk.makeApplicationCallTxnFromObject({
      sender: relayer.addr,
      appIndex: verifierAppId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [proofBytes, signalsBytes],
      foreignApps: budgetHelperAppId ? [budgetHelperAppId] : [],
      suggestedParams: { ...params, fee: BigInt(213_000), flatFee: true },
    })

    // [1] Pool withdraw app call
    const recipientPubKey = algosdk.decodeAddress(body.recipient).publicKey
    const relayerPubKey = algosdk.decodeAddress(relayer.addr).publicKey

    const recipientSignalBytes = addressToSignalBytes(body.recipient)
    const relayerSignalBytes = addressToSignalBytes(relayer.addr)

    const withdrawAppCall = algosdk.makeApplicationCallTxnFromObject({
      sender: relayer.addr,
      appIndex: body.poolAppId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [
        WITHDRAW_SELECTOR,
        abiEncodeBytes(nullifierHashBytes),
        recipientPubKey,
        relayerPubKey,
        uint64ToBytes(BigInt(relayFee)),
        abiEncodeBytes(rootBytes),
        abiEncodeBytes(recipientSignalBytes),
        abiEncodeBytes(relayerSignalBytes),
      ],
      accounts: [body.recipient],
      boxes: [
        { appIndex: body.poolAppId, name: nullBoxName },
        { appIndex: body.poolAppId, name: (() => { const n = new Uint8Array(2 + 32); n.set(new TextEncoder().encode('kr'), 0); n.set(rootBytes, 2); return n; })() },
      ],
      suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
    })

    algosdk.assignGroupID([verifierAppCall, withdrawAppCall])

    const signedVerifier = verifierAppCall.signTxn(relayer.sk)
    const signedWithdraw = withdrawAppCall.signTxn(relayer.sk)

    const resp = await algod.sendRawTransaction([signedVerifier, signedWithdraw]).do()
    const txId = (resp as any).txid ?? (resp as any).txId ?? withdrawAppCall.txID()

    await algosdk.waitForConfirmation(algod, txId, 4)

    return json({ txId, status: 'confirmed' })
  } catch (err: any) {
    console.error('Relayer withdraw error:', err)
    return json({ error: err?.message || 'Transaction failed' }, 500)
  }
}
