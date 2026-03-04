import algosdk from 'algosdk'
import { ALGOD_CONFIG, INDEXER_CONFIG } from './config'
import { checkViewTag, decryptNote, HPKE_ENVELOPE_LEN } from './hpke'
import { mimcHashTriple, initMimc, scalarToBytes, uint64ToBytes, computeNullifierHash, type DepositNote } from './privacy'

export interface ScanResult {
  recovered: DepositNote[]
  errors: string[]       // non-fatal errors encountered during scan
  complete: boolean      // true if all pools were fully scanned without errors
}

/**
 * Scan confirmed transactions for HPKE-encrypted notes addressed to the given view key.
 *
 * Algorithm:
 * 1. Use indexer to search transactions for each pool app ID
 * 2. For each transaction with a note field >= 190 bytes:
 *    a. Parse the HPKE envelope header (version, suite)
 *    b. Fast check: compute view tag, compare (skip if mismatch)
 *    c. Full decrypt: HPKE open, deserialize note
 *    d. Verify: recompute commitment from decrypted values
 *    e. Verify: check commitment exists on-chain at claimed leafIndex
 * 3. Return all recovered notes with error/completeness info
 */
export async function scanChainForNotes(
  viewKeypair: { privateKey: Uint8Array; publicKey: Uint8Array },
  poolAppIds: number[],
  fromRound?: number,
  onProgress?: (round: number, found: number) => void,
): Promise<ScanResult> {
  await initMimc()

  const indexer = new algosdk.Indexer(
    INDEXER_CONFIG.token,
    INDEXER_CONFIG.baseServer,
    INDEXER_CONFIG.port,
  )
  const algod = new algosdk.Algodv2(ALGOD_CONFIG.token, ALGOD_CONFIG.baseServer, ALGOD_CONFIG.port)

  const recovered: DepositNote[] = []
  const errors: string[] = []
  let lastRound = 0
  let complete = true

  for (const appId of poolAppIds) {
    let nextToken: string | undefined
    let hasMore = true

    while (hasMore) {
      // Search for application transactions
      let query = indexer.searchForTransactions()
        .applicationID(appId)
        .txType('appl')
        .limit(100)

      if (fromRound !== undefined && fromRound > 0) {
        query = query.minRound(fromRound)
      }
      if (nextToken) {
        query = query.nextToken(nextToken)
      }

      let response: any
      try {
        response = await query.do()
      } catch (err: any) {
        errors.push(`Indexer error for pool ${appId}: ${err?.message || 'unknown'}`)
        complete = false
        break // Can't continue pagination for this pool
      }

      const txns = response.transactions || []
      if (txns.length === 0) {
        hasMore = false
        break
      }

      for (const txn of txns) {
        const round = txn['confirmed-round'] || txn.confirmedRound || 0
        if (round > lastRound) lastRound = round

        // Check for note field with HPKE envelope
        const noteB64 = txn.note || txn['application-transaction']?.note
        if (!noteB64) continue

        let noteBytes: Uint8Array
        try {
          noteBytes = typeof noteB64 === 'string'
            ? Uint8Array.from(atob(noteB64), c => c.charCodeAt(0))
            : new Uint8Array(noteB64)
        } catch {
          continue
        }

        if (noteBytes.length < HPKE_ENVELOPE_LEN) continue

        // Fast view tag check
        if (!checkViewTag(noteBytes, viewKeypair.privateKey)) {
          continue
        }

        // Full HPKE decrypt
        const decrypted = await decryptNote(noteBytes, viewKeypair.privateKey)
        if (!decrypted) continue

        // Verify commitment: recompute from decrypted values
        const recomputedCommitment = mimcHashTriple(
          decrypted.secret,
          decrypted.nullifier,
          decrypted.denomination,
        )

        // Verify commitment exists on-chain at the claimed leafIndex
        const commitBytes = scalarToBytes(recomputedCommitment)
        const cmtBoxName = new Uint8Array(11)
        const TEXT_ENCODER = new TextEncoder()
        cmtBoxName.set(TEXT_ENCODER.encode('cmt'), 0)
        cmtBoxName.set(uint64ToBytes(BigInt(decrypted.leafIndex)), 3)
        try {
          const boxResult = await algod.getApplicationBoxByName(appId, cmtBoxName).do()
          const onChainBytes = new Uint8Array(boxResult.value as ArrayLike<number>)
          if (onChainBytes.length !== commitBytes.length) continue
          let match = true
          for (let j = 0; j < commitBytes.length; j++) {
            if (onChainBytes[j] !== commitBytes[j]) { match = false; break }
          }
          if (!match) continue // On-chain commitment doesn't match — forged note
        } catch {
          continue // Box doesn't exist — commitment not on-chain
        }

        // Check if nullifier is already spent (e.g., privateSend burns nullifier on creation)
        const nullHash = computeNullifierHash(decrypted.nullifier)
        const nullBytes = scalarToBytes(nullHash)
        const nullBoxName = new Uint8Array(4 + nullBytes.length)
        const NULL_PREFIX = new TextEncoder().encode('null')
        nullBoxName.set(NULL_PREFIX, 0)
        nullBoxName.set(nullBytes, 4)
        try {
          await algod.getApplicationBoxByName(appId, nullBoxName).do()
          continue // Nullifier already spent — skip this note
        } catch {
          // Not spent — note is recoverable
        }

        const note: DepositNote = {
          secret: decrypted.secret,
          nullifier: decrypted.nullifier,
          commitment: recomputedCommitment,
          leafIndex: decrypted.leafIndex,
          denomination: decrypted.denomination,
          assetId: 0,
          timestamp: Date.now(),
          appId,
        }

        recovered.push(note)
        onProgress?.(lastRound, recovered.length)
      }

      nextToken = response['next-token'] || response.nextToken
      if (!nextToken) {
        hasMore = false
      }
    }
  }

  onProgress?.(lastRound, recovered.length)
  return { recovered, errors, complete }
}
