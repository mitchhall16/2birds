/**
 * PLONK LogicSig Verifier — Transaction Group Builder
 *
 * Group structure (4 txns, all same LogicSig program):
 *   [0] Payment $0 (LogicSig) — verifier: arg0=proof, arg1=inverses
 *   [1] Payment $0 (LogicSig) — VK in Note (budget padding)
 *   [2] Payment $0 (LogicSig) — budget padding
 *   [3] Payment $0 (LogicSig) — signals in Note (pool contract reads this)
 *
 * Cost: 4 × 0.001 ALGO = 0.004 ALGO
 * Budget: 4 × 20K = 80K cost units (pooled LogicSig budget, AVM v11)
 */

import algosdk from 'algosdk'

// ── BN254 scalar field for inverse computation ──
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/** VK chunks data loaded from the build output */
export interface PlonkVKChunks {
  hash: string       // hex SHA256 of serialized VK
  chunks: string[]   // hex-encoded VK chunks for Note fields
  nPublic: number
  power: number
}

/** Compiled PLONK verifier LogicSig (loaded once per circuit) */
export interface PlonkVerifierProgram {
  lsig: algosdk.LogicSigAccount
  programBytes: Uint8Array
  vkChunks: PlonkVKChunks
  address: string
}

/** Number of LogicSig transactions in a PLONK verification group */
export const PLONK_LSIG_GROUP_SIZE = 4

/** Fee for PLONK LogicSig verification (4 txns × min fee) */
export const PLONK_LSIG_FEE = 4_000n // 0.004 ALGO

/**
 * Compile a PLONK verifier LogicSig from TEAL source.
 * Call this once per circuit type (deposit, withdraw, privateSend).
 */
export async function compilePlonkVerifier(
  client: algosdk.Algodv2,
  tealSource: string,
  vkChunks: PlonkVKChunks,
): Promise<PlonkVerifierProgram> {
  const compiled = await client.compile(Buffer.from(tealSource)).do()
  const program = new Uint8Array(Buffer.from(compiled.result, 'base64'))
  const lsig = new algosdk.LogicSigAccount(program)
  return {
    lsig,
    programBytes: program,
    vkChunks,
    address: lsig.address() as unknown as string,
  }
}

/**
 * Encode a PLONK proof for the LogicSig verifier (arg 0).
 *
 * snarkjs PLONK proof → 768-byte packed format:
 *   A(64) || B(64) || C(64) || Z(64) || T1(64) || T2(64) || T3(64) ||
 *   eval_a(32) || eval_b(32) || eval_c(32) || eval_s1(32) || eval_s2(32) || eval_zw(32) ||
 *   Wxi(64) || Wxiw(64)
 */
export function encodePlonkProof(proof: any): Uint8Array {
  const result = new Uint8Array(768)

  function encodeG1(point: string[], offset: number) {
    const x = BigInt(point[0])
    const y = BigInt(point[1])
    for (let i = 31; i >= 0; i--) {
      result[offset + i] = Number(x >> BigInt((31 - i) * 8) & 0xffn)
      result[offset + 32 + i] = Number(y >> BigInt((31 - i) * 8) & 0xffn)
    }
  }

  function encodeScalar(value: string, offset: number) {
    const n = BigInt(value)
    for (let i = 31; i >= 0; i--) {
      result[offset + i] = Number(n >> BigInt((31 - i) * 8) & 0xffn)
    }
  }

  encodeG1(proof.A, 0)
  encodeG1(proof.B, 64)
  encodeG1(proof.C, 128)
  encodeG1(proof.Z, 192)
  encodeG1(proof.T1, 256)
  encodeG1(proof.T2, 320)
  encodeG1(proof.T3, 384)
  encodeScalar(proof.eval_a, 448)
  encodeScalar(proof.eval_b, 480)
  encodeScalar(proof.eval_c, 512)
  encodeScalar(proof.eval_s1, 544)
  encodeScalar(proof.eval_s2, 576)
  encodeScalar(proof.eval_zw, 608)
  encodeG1(proof.Wxi, 640)
  encodeG1(proof.Wxiw, 704)

  return result
}

/**
 * Encode public signals as big-endian 32-byte scalars.
 */
export function encodeSignals(signals: string[]): Uint8Array {
  const result = new Uint8Array(signals.length * 32)
  for (let s = 0; s < signals.length; s++) {
    const n = BigInt(signals[s])
    for (let i = 31; i >= 0; i--) {
      result[s * 32 + i] = Number(n >> BigInt((31 - i) * 8) & 0xffn)
    }
  }
  return result
}

// ── Fiat-Shamir challenge derivation (must match TEAL verifier) ──

function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n >> BigInt((31 - i) * 8) & 0xffn)
  }
  return buf
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i])
  }
  return result
}

/**
 * Keccak256 hash (NOT SHA3-256 — they use different padding).
 * Requires js-sha3 which is a dependency of snarkjs.
 */
async function keccak256(data: Uint8Array): Promise<Uint8Array> {
  const { keccak256: k } = await import('js-sha3')
  return new Uint8Array(k.arrayBuffer(data))
}

async function hashModR(data: Uint8Array): Promise<bigint> {
  const hash = await keccak256(data)
  return bytesToBigint(hash) % BN254_R
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

/**
 * Derive Fiat-Shamir challenges from proof and VK (matching snarkjs transcript).
 *
 * Returns xi which is needed to compute the precomputed inverses.
 */
export async function deriveFiatShamirXi(
  vkChunks: PlonkVKChunks,
  proof: any,
  signals: string[],
  vkeyJson: any,
): Promise<{ xi: bigint; zh: bigint; xin: bigint }> {
  // Encode VK G1 points (Qm, Ql, Qr, Qo, Qc, S1, S2, S3) as 64-byte BE each
  const vkPoints: Uint8Array[] = []
  for (const key of ['Qm', 'Ql', 'Qr', 'Qo', 'Qc', 'S1', 'S2', 'S3']) {
    const p = vkeyJson[key] as string[]
    const buf = new Uint8Array(64)
    const x = BigInt(p[0])
    const y = BigInt(p[1])
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(x >> BigInt((31 - i) * 8) & 0xffn)
      buf[32 + i] = Number(y >> BigInt((31 - i) * 8) & 0xffn)
    }
    vkPoints.push(buf)
  }

  const signalsBytes = encodeSignals(signals)
  const proofBytes = encodePlonkProof(proof)

  // A, B, C are first 3 G1 points in proof (64 bytes each)
  const proofA = proofBytes.slice(0, 64)
  const proofB = proofBytes.slice(64, 128)
  const proofC = proofBytes.slice(128, 192)
  const proofZ = proofBytes.slice(192, 256)
  const proofT1 = proofBytes.slice(256, 320)
  const proofT2 = proofBytes.slice(320, 384)
  const proofT3 = proofBytes.slice(384, 448)

  // beta = keccak256(Qm||Ql||Qr||Qo||Qc||S1||S2||S3||signals||A||B||C) mod r
  const betaInput = concatBytes(...vkPoints, signalsBytes, proofA, proofB, proofC)
  const beta = await hashModR(betaInput)

  // gamma = keccak256(beta) mod r
  const gamma = await hashModR(bigintToBytes32(beta))

  // alpha = keccak256(beta||gamma||Z) mod r
  const alpha = await hashModR(concatBytes(bigintToBytes32(beta), bigintToBytes32(gamma), proofZ))

  // xi = keccak256(alpha||T1||T2||T3) mod r
  const xi = await hashModR(concatBytes(bigintToBytes32(alpha), proofT1, proofT2, proofT3))

  // Compute xin = xi^n and zh = xin - 1
  const power = vkChunks.power
  let xin = xi
  for (let i = 0; i < power; i++) {
    xin = (xin * xin) % BN254_R
  }
  const zh = (xin - 1n + BN254_R) % BN254_R

  return { xi, zh, xin }
}

/**
 * Compute modular inverse using Fermat's little theorem: a^(r-2) mod r.
 */
function modInverse(a: bigint, mod: bigint = BN254_R): bigint {
  if (a === 0n) throw new Error('Cannot invert zero')
  let result = 1n
  let base = ((a % mod) + mod) % mod
  let exp = mod - 2n
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return result
}

/**
 * Compute precomputed inverses for Lagrange basis evaluation.
 *
 * For each public input i (0..nPublic-1):
 *   inv[i] = 1 / (n * (xi - omega^i))
 *
 * where omega is the primitive root of unity (VK.w).
 * The TEAL verifier checks: inv[i] * n * (xi - omega^i) ≡ 1 (mod r)
 */
export function computePrecomputedInverses(
  xi: bigint,
  omega: bigint,
  n: number,
  nPublic: number,
): Uint8Array {
  const result = new Uint8Array(nPublic * 32)
  let wi = 1n // omega^0 = 1

  for (let i = 0; i < nPublic; i++) {
    const xiMinusWi = ((xi - wi) % BN254_R + BN254_R) % BN254_R
    const nTimesXiMinusWi = (BigInt(n) * xiMinusWi) % BN254_R
    const inv = modInverse(nTimesXiMinusWi)

    // Verify: inv * nTimesXiMinusWi mod r == 1
    if ((inv * nTimesXiMinusWi) % BN254_R !== 1n) {
      throw new Error(`Inverse verification failed for i=${i}`)
    }

    // Write as 32-byte BE
    for (let j = 31; j >= 0; j--) {
      result[i * 32 + j] = Number(inv >> BigInt((31 - j) * 8) & 0xffn)
    }

    wi = (wi * omega) % BN254_R
  }
  return result
}

/**
 * Build the LogicSig verification transaction group.
 *
 * Returns 4 transactions that should be prepended to the pool app call group.
 *   [0] Verifier — carries signals in Note (for pool contract reference)
 *   [1] VK carrier — full serialized VK in Note
 *   [2] Budget padding — empty Note
 *   [3] Signal carrier — signals in Note (pool contract reads this)
 */
export function buildPlonkVerifierGroup(
  verifier: PlonkVerifierProgram,
  proofBytes: Uint8Array,
  signalsBytes: Uint8Array,
  sender: string,
  params: algosdk.SuggestedParams,
): algosdk.Transaction[] {
  // Decode VK chunk 0 (full VK fits in one chunk, ≤1024 bytes)
  const vkBytes = new Uint8Array(verifier.vkChunks.chunks[0].length / 2)
  const hexStr = verifier.vkChunks.chunks[0]
  for (let i = 0; i < hexStr.length; i += 2) {
    vkBytes[i / 2] = parseInt(hexStr.substring(i, i + 2), 16)
  }

  const makePay = (note?: Uint8Array) =>
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: verifier.address,
      receiver: verifier.address,
      amount: 0,
      suggestedParams: { ...params, fee: BigInt(1000), flatFee: true },
      note,
    })

  return [
    makePay(),                // [0] verifier (no Note needed, args carry data)
    makePay(vkBytes),         // [1] VK in Note
    makePay(),                // [2] budget padding
    makePay(signalsBytes),    // [3] signals in Note (pool contract reads)
  ]
}

/**
 * Sign the LogicSig transactions in a group.
 * Call this after assignGroupID on the full transaction group.
 *
 * @param proofBytes — proof bytes (arg 0)
 * @param inversesBytes — precomputed inverses (arg 1)
 */
export function signPlonkVerifierTxns(
  verifier: PlonkVerifierProgram,
  txns: algosdk.Transaction[],
  proofBytes: Uint8Array,
  inversesBytes: Uint8Array,
): Uint8Array[] {
  // LogicSig with proof as arg[0] and inverses as arg[1]
  const lsigWithArgs = new algosdk.LogicSigAccount(
    verifier.programBytes,
    [proofBytes, inversesBytes],
  )
  return txns.slice(0, PLONK_LSIG_GROUP_SIZE).map(txn =>
    algosdk.signLogicSigTransaction(txn, lsigWithArgs).blob
  )
}

/**
 * Check if PLONK LogicSig verification is available for a circuit type.
 */
export function isPlonkLsigAvailable(verifierAddress: string | undefined): boolean {
  if (!verifierAddress) return false
  return verifierAddress !== 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'
}
