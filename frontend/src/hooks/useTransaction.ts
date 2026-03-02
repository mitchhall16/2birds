import { useState, useCallback, useEffect } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import algosdk from 'algosdk'
import { CONTRACTS, ALGOD_CONFIG, FEES, isValidTier, DENOMINATION_TIERS, getPoolForTier, RELAYER_URL, RELAYER_ADDRESS, RELAYER_FEE } from '../lib/config'
import { useToast } from '../contexts/ToastContext'
import { humanizeError } from '../lib/errorMessages'
import {
  initMimc,
  deriveDeposit,
  deriveMasterKey,
  getCachedMasterKey,
  getNextDepositIndex,
  incrementDepositIndex,
  computeNullifierHash,
  scalarToBytes,
  bytesToScalar,
  uint64ToBytes,
  abiEncodeBytes,
  addressToScalar,
  encodeProofForVerifier,
  encodePublicSignals,
  encodeDepositSignals,
  encodePrivateSendSignals,
  METHOD_SELECTORS,
  depositBoxRefs,
  privateSendBoxRefs,
  nullifierBox,
  withdrawBoxRefs,
  readEvictedRoot,
  saveNote,
  loadNotes,
  removeNote,
  removeNoteByCommitment,
  isNullifierSpent,
  PasswordRequiredError,
  DepositNote,
  setActiveWallet,
} from '../lib/privacy'
import {
  getOrCreateTree,
  insertLeaf,
  getPath,
  saveTree,
  clearTreeCache,
  incrementalSyncTree,
  syncAllTreesFromChain,
} from '../lib/tree'

export type TxStage =
  | 'idle'
  | 'depositing'
  | 'deposit_complete'
  | 'generating_proof'
  | 'withdrawing'
  | 'withdraw_complete'
  | 'error'

interface TxState {
  stage: TxStage
  message: string
  txId: string | null
  error: string | null
  savedNotes: DepositNote[]
}

interface UseTransactionReturn extends TxState {
  deposit: (microAlgos: bigint) => Promise<void>
  withdraw: (noteCommitment: bigint, destinationAddr: string) => Promise<void>
  privateSend: (microAlgos: bigint, destinationAddr: string) => Promise<void>
  reset: () => Promise<void>
  refreshNotes: () => Promise<void>
  rebuildAllTrees: (onProgress?: (pool: string, done: boolean) => void) => Promise<void>
  useRelayer: boolean
  setUseRelayer: (v: boolean) => void
  relayerAvailable: boolean
}

const VERIFIER_APP_ID = CONTRACTS.ZkVerifier.appId
const BUDGET_HELPER_APP_ID = CONTRACTS.ZkVerifier.budgetHelperAppId
const DEPOSIT_VERIFIER_APP_ID = CONTRACTS.DepositVerifier.appId
const DEPOSIT_BUDGET_HELPER_APP_ID = CONTRACTS.DepositVerifier.budgetHelperAppId
const PRIVATESEND_VERIFIER_APP_ID = CONTRACTS.PrivateSendVerifier.appId
const PRIVATESEND_BUDGET_HELPER_APP_ID = CONTRACTS.PrivateSendVerifier.budgetHelperAppId

// Guard: refuse to operate if verifier apps are not deployed
if (!VERIFIER_APP_ID) console.error('ZkVerifier appId is 0 — withdrawals will fail. Run the deploy script.')
if (!DEPOSIT_VERIFIER_APP_ID) console.error('DepositVerifier appId is 0 — deposits will fail. Run the deploy script.')
if (!PRIVATESEND_VERIFIER_APP_ID) console.error('PrivateSendVerifier appId is 0 — privateSend will fail. Run the deploy script.')

export function useTransaction(): UseTransactionReturn {
  const { activeAddress, transactionSigner, algodClient, signData } = useWallet()
  const { addToast } = useToast()
  const relayerAvailable = !!RELAYER_URL && !!RELAYER_ADDRESS
  const [useRelayerState, setUseRelayer] = useState(relayerAvailable)
  const [state, setState] = useState<TxState>({
    stage: 'idle',
    message: '',
    txId: null,
    error: null,
    savedNotes: [],
  })

  // Track active wallet for per-wallet deposit counter
  useEffect(() => {
    if (activeAddress) setActiveWallet(activeAddress)
  }, [activeAddress])

  // Load notes async on mount
  useEffect(() => {
    loadNotes().then(notes => setState(s => ({ ...s, savedNotes: notes })))
  }, [])

  const getClient = useCallback(() => {
    return algodClient ?? new algosdk.Algodv2(
      ALGOD_CONFIG.token,
      ALGOD_CONFIG.baseServer,
      ALGOD_CONFIG.port,
    )
  }, [algodClient])

  /** Read contract global state */
  async function readContractState(client: algosdk.Algodv2, appId: number) {
    const appInfo = await client.getApplicationByID(appId).do()
    const globalState = (appInfo as any).params?.globalState || (appInfo as any).params?.['global-state'] || []

    let currentRoot = new Uint8Array(32)
    let rootHistoryIndex = 0
    let nextIndex = 0

    for (const kv of globalState) {
      const key = typeof kv.key === 'string' ? atob(kv.key) : new TextDecoder().decode(kv.key)
      if (key === 'root') {
        const val = kv.value?.bytes ?? kv.value?.tb
        if (val) {
          currentRoot = typeof val === 'string' ? Uint8Array.from(atob(val), c => c.charCodeAt(0)) : val
        }
      } else if (key === 'rhi') {
        rootHistoryIndex = Number(kv.value?.uint ?? kv.value?.ui ?? 0)
      } else if (key === 'next_idx') {
        nextIndex = Number(kv.value?.uint ?? kv.value?.ui ?? 0)
      }
    }

    return { currentRoot, rootHistoryIndex, nextIndex }
  }

  function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /** Submit a withdrawal via the relayer service */
  async function submitViaRelayer(
    proofBytes: Uint8Array,
    signalsBytes: Uint8Array,
    poolAppId: number,
    nullifierHashBytes: Uint8Array,
    rootBytes: Uint8Array,
    recipient: string,
    fee: number,
  ): Promise<string> {
    const resp = await fetch(`${RELAYER_URL}/api/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: bytesToHex(proofBytes),
        signals: bytesToHex(signalsBytes),
        poolAppId,
        nullifierHash: bytesToHex(nullifierHashBytes),
        root: bytesToHex(rootBytes),
        recipient,
        relayerAddress: RELAYER_ADDRESS,
        fee,
      }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.error || 'Relayer request failed')
    return data.txId
  }

  /** Check wallet balance is sufficient before starting expensive proof generation */
  async function checkBalance(client: algosdk.Algodv2, sender: string, requiredMicroAlgos: bigint): Promise<void> {
    const accountInfo = await client.accountInformation(sender).do()
    const balance = BigInt(accountInfo.amount)
    const minBalance = BigInt(accountInfo.minBalance ?? 100_000)
    const available = balance - minBalance
    if (available < requiredMicroAlgos) {
      const needed = (Number(requiredMicroAlgos) / 1_000_000).toFixed(3)
      const have = (Number(available) / 1_000_000).toFixed(3)
      throw new Error(`Insufficient balance: need ${needed} ALGO but only ${have} ALGO available (after min balance)`)
    }
  }

  /** Build and submit a deposit with ZK insertion proof. Returns txId. */
  async function executeDeposit(
    client: algosdk.Algodv2,
    sender: string,
    signer: typeof transactionSigner,
    pool: { appId: number; appAddress: string },
    note: DepositNote,
    microAlgos: bigint,
  ): Promise<string> {
    const commitmentBytes = scalarToBytes(note.commitment)

    // Incremental sync: only fetch new leaves since last sync (O(delta) not O(N))
    setState(s => ({ ...s, message: 'Syncing Merkle tree...' }))
    const tree = await incrementalSyncTree(pool.appId)

    // Use the synced tree's root directly as oldRoot (avoids race with separate RPC read)
    const oldRoot = tree.root

    // Read contract state only for box reference indices
    const contractState = await readContractState(client, pool.appId)

    // Insert into synced local tree
    const { index: leafIndex, root: mimcRoot } = insertLeaf(tree, note.commitment)
    note.leafIndex = leafIndex

    const mimcRootBytes = scalarToBytes(mimcRoot)

    // Get Merkle path for the insertion proof
    const merklePath = getPath(tree, leafIndex)

    // Generate deposit insertion ZK proof
    setState(s => ({ ...s, stage: 'generating_proof', message: 'Generating deposit proof... (10-30 sec)' }))

    const snarkjs = await import('snarkjs')

    const circuitInput = {
      oldRoot: oldRoot.toString(),
      newRoot: mimcRoot.toString(),
      commitment: note.commitment.toString(),
      leafIndex: leafIndex.toString(),
      pathElements: merklePath.pathElements.map(e => e.toString()),
    }

    const { proof } = await snarkjs.groth16.fullProve(
      circuitInput,
      '/circuits/deposit.wasm',
      '/circuits/deposit_final.zkey',
    )

    const groth16Proof = {
      pi_a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
      pi_b: [
        [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
        [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
      ] as [[bigint, bigint], [bigint, bigint]],
      pi_c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    }

    const proofBytes = encodeProofForVerifier(groth16Proof)
    const signalsBytes = encodeDepositSignals(oldRoot, mimcRoot, note.commitment, BigInt(leafIndex))

    // Pre-check: re-read on-chain root after proof gen — if it changed, skip submission
    setState(s => ({ ...s, stage: 'depositing', message: 'Verifying tree state...' }))
    const freshState = await readContractState(client, pool.appId)
    if (bytesToScalar(freshState.currentRoot) !== oldRoot) {
      throw new Error('Tree root changed during proof generation (concurrent deposit)')
    }

    setState(s => ({ ...s, message: 'Building deposit transaction...' }))
    const params = await client.getTransactionParams().do()

    // Read evicted root for knownRoots pruning (only when ring buffer wraps at >=1000 deposits)
    const evictedRoot = await readEvictedRoot(client, pool.appId, freshState.rootHistoryIndex)
    const boxes = depositBoxRefs(pool.appId, freshState.rootHistoryIndex, freshState.nextIndex, mimcRootBytes, evictedRoot)

    // Build 3-txn group: [deposit verifier, payment, pool deposit]
    const verifierAppCall = algosdk.makeApplicationCallTxnFromObject({
      sender,
      appIndex: DEPOSIT_VERIFIER_APP_ID,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [proofBytes, signalsBytes],
      foreignApps: [DEPOSIT_BUDGET_HELPER_APP_ID],
      suggestedParams: { ...params, fee: FEES.verifierCall, flatFee: true },
    })

    const payTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: pool.appAddress,
      amount: Number(microAlgos),
      suggestedParams: params,
    })

    const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
      sender,
      appIndex: pool.appId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [
        METHOD_SELECTORS.deposit,
        abiEncodeBytes(commitmentBytes),
        abiEncodeBytes(mimcRootBytes),
      ],
      foreignApps: [DEPOSIT_VERIFIER_APP_ID],
      boxes,
      suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
    })

    algosdk.assignGroupID([verifierAppCall, payTxn, appCallTxn])

    setState(s => ({ ...s, message: 'Approve deposit in your wallet...' }))
    const signedTxns = await signer([verifierAppCall, payTxn, appCallTxn], [0, 1, 2])

    setState(s => ({ ...s, message: 'Submitting deposit...' }))
    const result = await client.sendRawTransaction(signedTxns).do()
    const txId = (result as any).txid ?? (result as any).txId

    setState(s => ({ ...s, message: 'Waiting for confirmation...' }))
    await algosdk.waitForConfirmation(client, txId, 4)

    // Persist tree after successful confirmation
    saveTree(tree, pool.appId)
    return txId
  }

  /** Detect if an error is a stale root mismatch (concurrent deposit) */
  function isStaleRootError(err: unknown): boolean {
    const msg = String(err)
    // Only retry on our explicit pre-check failure (detected before submission, no wasted fee)
    return msg.includes('concurrent deposit')
  }

  const MAX_DEPOSIT_RETRIES = 3

  // ── DEPOSIT ──────────────────────────────
  const deposit = useCallback(async (microAlgos: bigint) => {
    if (!activeAddress || !transactionSigner) {
      addToast('error', 'Wallet not connected')
      setState(s => ({ ...s, stage: 'error', error: 'Wallet not connected' }))
      return
    }

    if (!isValidTier(microAlgos)) {
      addToast('error', `Invalid denomination. Use ${DENOMINATION_TIERS.map(t => t.label).join(', ')} ALGO`)
      setState(s => ({ ...s, stage: 'error', error: 'Invalid denomination tier' }))
      return
    }

    if (!DEPOSIT_VERIFIER_APP_ID) {
      addToast('error', 'Deposit verifier not deployed. Run the deploy script first.')
      setState(s => ({ ...s, stage: 'error', error: 'Deposit verifier not deployed (appId = 0)' }))
      return
    }

    const amountMicroAlgo = Number(microAlgos)
    const amountAlgo = amountMicroAlgo / 1_000_000
    const client = getClient()
    const pool = getPoolForTier(microAlgos)

    try {
      setState(s => ({ ...s, stage: 'depositing', message: 'Initializing cryptography...', txId: null, error: null }))

      await initMimc()

      // Pre-check wallet balance before expensive proof generation
      setState(s => ({ ...s, message: 'Checking wallet balance...' }))
      await checkBalance(client, activeAddress, microAlgos + FEES.deposit)

      // Derive deterministic note from wallet signature (or use cached master key)
      setState(s => ({ ...s, message: 'Deriving deposit key...' }))
      const masterKey = await deriveMasterKey(signData)
      const depositIdx = getNextDepositIndex()
      const note = deriveDeposit(masterKey, depositIdx, microAlgos, 0)

      // Attempt deposit with retry on stale root (concurrent deposit by another user)
      let txId: string | undefined
      for (let attempt = 1; attempt <= MAX_DEPOSIT_RETRIES; attempt++) {
        try {
          txId = await executeDeposit(client, activeAddress, transactionSigner, pool, note, microAlgos)
          break // success
        } catch (err) {
          if (attempt < MAX_DEPOSIT_RETRIES && isStaleRootError(err)) {
            console.warn(`Deposit attempt ${attempt} failed (stale root), retrying...`)
            clearTreeCache(pool.appId) // Force fresh sync on retry
            setState(s => ({
              ...s,
              stage: 'depositing',
              message: `Another deposit was processed. Retrying... (${attempt}/${MAX_DEPOSIT_RETRIES})`,
            }))
            continue
          }
          throw err // non-retryable or out of retries
        }
      }

      // Persist note and increment deterministic counter
      await saveNote(note)
      incrementDepositIndex()

      addToast('success', `Deposited ${amountAlgo} ALGO into the privacy pool`)
      const updatedNotes = await loadNotes()
      setState({
        stage: 'deposit_complete',
        message: `Deposit confirmed! ${amountAlgo} ALGO is now shielded in the pool.`,
        txId: txId!,
        error: null,
        savedNotes: updatedNotes,
      })
    } catch (err) {
      if (err instanceof PasswordRequiredError) throw err
      const msg = humanizeError(err)
      console.error('Deposit error:', err)
      addToast('error', msg)
      setState(s => ({ ...s, stage: 'error', error: msg }))
    }
  }, [activeAddress, transactionSigner, signData, getClient, addToast])

  // ── WITHDRAW ─────────────────────────────
  const withdraw = useCallback(async (noteCommitment: bigint, destinationAddr: string) => {
    if (!activeAddress || !transactionSigner) {
      addToast('error', 'Wallet not connected')
      setState(s => ({ ...s, stage: 'error', error: 'Wallet not connected' }))
      return
    }

    if (!algosdk.isValidAddress(destinationAddr)) {
      addToast('error', 'Invalid destination address')
      setState(s => ({ ...s, stage: 'error', error: 'Invalid destination address' }))
      return
    }

    if (!VERIFIER_APP_ID) {
      addToast('error', 'Withdraw verifier not deployed. Run the deploy script first.')
      setState(s => ({ ...s, stage: 'error', error: 'Withdraw verifier not deployed (appId = 0)' }))
      return
    }

    const notes = await loadNotes()
    const note = notes.find(n => n.commitment === noteCommitment)
    if (!note) {
      addToast('error', 'No deposit note found')
      setState(s => ({ ...s, stage: 'error', error: 'No deposit note found' }))
      return
    }
    const client = getClient()
    const pool = getPoolForTier(note.denomination)

    try {
      setState(s => ({ ...s, stage: 'withdrawing', message: 'Checking note status...', txId: null, error: null }))

      await initMimc()

      // Check if nullifier is already spent before generating expensive proof
      const alreadySpent = await isNullifierSpent(client, pool.appId, note.nullifier)
      if (alreadySpent) {
        await removeNoteByCommitment(note.commitment)
        const updated = await loadNotes()
        addToast('error', 'This note has already been withdrawn')
        setState({ stage: 'error', message: '', error: 'Note already spent on-chain', txId: null, savedNotes: updated })
        return
      }

      // Sync local Merkle tree from chain before proof generation
      setState(s => ({ ...s, message: 'Syncing Merkle tree...' }))
      const tree = await incrementalSyncTree(pool.appId)
      const merklePath = getPath(tree, note.leafIndex)
      const root = tree.root

      // Generate ZK proof
      setState(s => ({ ...s, stage: 'generating_proof', message: 'Computing zero-knowledge proof... (10-30 sec)' }))

      const snarkjs = await import('snarkjs')

      const nullifierHash = computeNullifierHash(note.nullifier)
      const viaRelayer = useRelayerState && relayerAvailable
      const relayerAddr = viaRelayer ? RELAYER_ADDRESS : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'
      const relayerFee = viaRelayer ? RELAYER_FEE : 0n

      const circuitInput = {
        // Public inputs
        root: root.toString(),
        nullifierHash: nullifierHash.toString(),
        recipient: addressToScalar(destinationAddr).toString(),
        relayer: addressToScalar(relayerAddr).toString(),
        fee: relayerFee.toString(),
        amount: note.denomination.toString(),
        // Private inputs
        secret: note.secret.toString(),
        nullifier: note.nullifier.toString(),
        pathElements: merklePath.pathElements.map(e => e.toString()),
        pathIndices: merklePath.pathIndices,
      }

      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInput,
        '/circuits/withdraw.wasm',
        '/circuits/withdraw_final.zkey',
      )

      // Convert snarkjs proof to our format
      const groth16Proof = {
        pi_a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
        pi_b: [
          [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
          [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
        ] as [[bigint, bigint], [bigint, bigint]],
        pi_c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
      }

      setState(s => ({ ...s, stage: 'withdrawing', message: 'Building withdrawal transaction...' }))

      // Encode proof and public signals for verifier app
      const proofBytes = encodeProofForVerifier(groth16Proof)
      const signalsBytes = encodePublicSignals(root, nullifierHash, destinationAddr, relayerAddr, relayerFee, note.denomination)
      const nullifierHashBytes = scalarToBytes(nullifierHash)
      const rootBytes = scalarToBytes(root)
      const recipientSignalBytes = scalarToBytes(addressToScalar(destinationAddr))
      const relayerSignalBytes = scalarToBytes(addressToScalar(relayerAddr))

      let txId: string

      if (viaRelayer) {
        // Submit via relayer — user doesn't sign, preserving privacy
        setState(s => ({ ...s, message: 'Submitting via relayer...' }))
        txId = await submitViaRelayer(
          proofBytes, signalsBytes, pool.appId,
          nullifierHashBytes, rootBytes, destinationAddr,
          Number(relayerFee),
        )
      } else {
        // Direct submission — user signs both transactions
        const params = await client.getTransactionParams().do()

        const verifierAppCall = algosdk.makeApplicationCallTxnFromObject({
          sender: activeAddress,
          appIndex: VERIFIER_APP_ID,
          onComplete: algosdk.OnApplicationComplete.NoOpOC,
          appArgs: [proofBytes, signalsBytes],
          foreignApps: [BUDGET_HELPER_APP_ID],
          suggestedParams: { ...params, fee: FEES.withdrawVerifierCall, flatFee: true },
        })

        const recipientPubKey = algosdk.decodeAddress(destinationAddr).publicKey
        const relayerPubKey = algosdk.decodeAddress(relayerAddr).publicKey

        const withdrawAppCall = algosdk.makeApplicationCallTxnFromObject({
          sender: activeAddress,
          appIndex: pool.appId,
          onComplete: algosdk.OnApplicationComplete.NoOpOC,
          appArgs: [
            METHOD_SELECTORS.withdraw,
            abiEncodeBytes(nullifierHashBytes),
            recipientPubKey,
            relayerPubKey,
            uint64ToBytes(0n),
            abiEncodeBytes(rootBytes),
            abiEncodeBytes(recipientSignalBytes),
            abiEncodeBytes(relayerSignalBytes),
          ],
          accounts: [destinationAddr],
          boxes: withdrawBoxRefs(pool.appId, nullifierHashBytes, rootBytes),
          suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
        })

        algosdk.assignGroupID([verifierAppCall, withdrawAppCall])

        setState(s => ({ ...s, message: 'Approve withdrawal in your wallet...' }))
        const signedTxns = await transactionSigner(
          [verifierAppCall, withdrawAppCall],
          [0, 1],
        )

        txId = withdrawAppCall.txID()
        setState(s => ({ ...s, message: 'Submitting withdrawal...' }))
        await client.sendRawTransaction(signedTxns).do()

        setState(s => ({ ...s, message: 'Waiting for confirmation...' }))
        await algosdk.waitForConfirmation(client, txId, 4)
      }

      // Remove used note by commitment (safe regardless of index shifts)
      await removeNoteByCommitment(note.commitment)

      const algoAmount = (Number(note.denomination) / 1_000_000).toFixed(6).replace(/\.?0+$/, '')
      addToast('success', `Withdrew ${algoAmount} ALGO to destination`)
      const wNotes = await loadNotes()
      setState({
        stage: 'withdraw_complete',
        message: `${algoAmount} ALGO withdrawn from the pool to the destination!`,
        txId,
        error: null,
        savedNotes: wNotes,
      })
    } catch (err) {
      if (err instanceof PasswordRequiredError) throw err
      const msg = humanizeError(err)
      console.error('Withdraw error:', err)
      addToast('error', msg)
      setState(s => ({ ...s, stage: 'error', error: msg }))
    }
  }, [activeAddress, transactionSigner, getClient, addToast, useRelayerState, relayerAvailable, signData])

  /** Build and submit a privateSend with ZK combined proof. Returns txId. */
  async function executePrivateSend(
    client: algosdk.Algodv2,
    sender: string,
    signer: typeof transactionSigner,
    pool: { appId: number; appAddress: string },
    note: DepositNote,
    microAlgos: bigint,
    destinationAddr: string,
  ): Promise<string> {
    // Sync tree and prepare insertion
    setState(s => ({ ...s, message: 'Syncing Merkle tree...' }))
    const tree = await incrementalSyncTree(pool.appId)
    const oldRoot = tree.root
    const contractState = await readContractState(client, pool.appId)

    const { index: leafIndex, root: newRoot } = insertLeaf(tree, note.commitment)
    note.leafIndex = leafIndex

    const merklePath = getPath(tree, leafIndex)
    const nullifierHash = computeNullifierHash(note.nullifier)
    const relayerAddr = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'
    const relayerFee = 0n

    // Generate ONE combined ZK proof (privateSend circuit)
    setState(s => ({ ...s, stage: 'generating_proof', message: 'Computing zero-knowledge proof... (10-30 sec)' }))

    const snarkjs = await import('snarkjs')

    const circuitInput = {
      oldRoot: oldRoot.toString(),
      newRoot: newRoot.toString(),
      commitment: note.commitment.toString(),
      leafIndex: leafIndex.toString(),
      nullifierHash: nullifierHash.toString(),
      recipient: addressToScalar(destinationAddr).toString(),
      relayer: addressToScalar(relayerAddr).toString(),
      fee: relayerFee.toString(),
      amount: microAlgos.toString(),
      secret: note.secret.toString(),
      nullifier: note.nullifier.toString(),
      pathElements: merklePath.pathElements.map(e => e.toString()),
    }

    const { proof } = await snarkjs.groth16.fullProve(
      circuitInput,
      '/circuits/privateSend.wasm',
      '/circuits/privateSend_final.zkey',
    )

    const groth16Proof = {
      pi_a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
      pi_b: [
        [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
        [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
      ] as [[bigint, bigint], [bigint, bigint]],
      pi_c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    }

    // Pre-check: re-read on-chain root after proof gen — if it changed, abort
    setState(s => ({ ...s, stage: 'depositing', message: 'Verifying tree state...' }))
    const freshState = await readContractState(client, pool.appId)
    if (bytesToScalar(freshState.currentRoot) !== oldRoot) {
      throw new Error('Tree root changed during proof generation (concurrent deposit)')
    }

    // Build 3-txn group: [privateSend verifier call, payment, pool privateSend call]
    setState(s => ({ ...s, stage: 'withdrawing', message: 'Building transaction...' }))

    const proofBytes = encodeProofForVerifier(groth16Proof)
    const signalsBytes = encodePrivateSendSignals(
      oldRoot, newRoot, note.commitment, BigInt(leafIndex),
      nullifierHash, destinationAddr, relayerAddr, relayerFee, microAlgos,
    )

    const commitmentBytes = scalarToBytes(note.commitment)
    const mimcRootBytes = scalarToBytes(newRoot)
    const nullifierHashBytes = scalarToBytes(nullifierHash)
    const recipientSignalBytes = scalarToBytes(addressToScalar(destinationAddr))
    const relayerSignalBytes = scalarToBytes(addressToScalar(relayerAddr))
    const recipientPubKey = algosdk.decodeAddress(destinationAddr).publicKey
    const relayerPubKey = algosdk.decodeAddress(relayerAddr).publicKey

    const params = await client.getTransactionParams().do()

    const verifierAppCall = algosdk.makeApplicationCallTxnFromObject({
      sender,
      appIndex: PRIVATESEND_VERIFIER_APP_ID,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [proofBytes, signalsBytes],
      foreignApps: [PRIVATESEND_BUDGET_HELPER_APP_ID],
      suggestedParams: { ...params, fee: FEES.privateSendVerifierCall, flatFee: true },
    })

    const payTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: pool.appAddress,
      amount: Number(microAlgos),
      suggestedParams: params,
    })

    // Read evicted root for knownRoots pruning (only when ring buffer wraps at >=1000 deposits)
    const evictedRoot = await readEvictedRoot(client, pool.appId, freshState.rootHistoryIndex)
    const boxes = privateSendBoxRefs(pool.appId, freshState.rootHistoryIndex, freshState.nextIndex, nullifierHashBytes, mimcRootBytes, evictedRoot)

    const poolAppCall = algosdk.makeApplicationCallTxnFromObject({
      sender,
      appIndex: pool.appId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [
        METHOD_SELECTORS.privateSend,
        abiEncodeBytes(commitmentBytes),
        abiEncodeBytes(mimcRootBytes),
        abiEncodeBytes(nullifierHashBytes),
        recipientPubKey,
        relayerPubKey,
        uint64ToBytes(0n),
        abiEncodeBytes(recipientSignalBytes),
        abiEncodeBytes(relayerSignalBytes),
      ],
      foreignApps: [PRIVATESEND_VERIFIER_APP_ID],
      accounts: [destinationAddr],
      boxes,
      suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
    })

    algosdk.assignGroupID([verifierAppCall, payTxn, poolAppCall])

    setState(s => ({ ...s, message: 'Approve transaction in your wallet...' }))
    const signedTxns = await signer(
      [verifierAppCall, payTxn, poolAppCall],
      [0, 1, 2],
    )

    setState(s => ({ ...s, message: 'Submitting transaction...' }))
    const result = await client.sendRawTransaction(signedTxns).do()
    const txId = (result as any).txid ?? (result as any).txId

    setState(s => ({ ...s, message: 'Waiting for confirmation...' }))
    await algosdk.waitForConfirmation(client, txId, 4)

    // Persist tree after successful confirmation
    saveTree(tree, pool.appId)
    return txId
  }

  // ── PRIVATE SEND (combined single-proof deposit+withdraw) ──
  const privateSend = useCallback(async (microAlgos: bigint, destinationAddr: string) => {
    if (!activeAddress || !transactionSigner) {
      addToast('error', 'Wallet not connected')
      setState(s => ({ ...s, stage: 'error', error: 'Wallet not connected' }))
      return
    }
    if (!isValidTier(microAlgos)) {
      addToast('error', `Invalid denomination. Use ${DENOMINATION_TIERS.map(t => t.label).join(', ')} ALGO`)
      setState(s => ({ ...s, stage: 'error', error: 'Invalid denomination tier' }))
      return
    }
    if (!algosdk.isValidAddress(destinationAddr)) {
      addToast('error', 'Invalid destination address')
      setState(s => ({ ...s, stage: 'error', error: 'Invalid destination address' }))
      return
    }

    if (!PRIVATESEND_VERIFIER_APP_ID) {
      addToast('error', 'PrivateSend verifier not deployed. Run the deploy script first.')
      setState(s => ({ ...s, stage: 'error', error: 'PrivateSend verifier not deployed (appId = 0)' }))
      return
    }

    const amountMicroAlgo = Number(microAlgos)
    const amountAlgo = amountMicroAlgo / 1_000_000
    const client = getClient()
    const pool = getPoolForTier(microAlgos)

    try {
      setState(s => ({ ...s, stage: 'depositing', message: 'Initializing cryptography...', txId: null, error: null }))

      await initMimc()

      // Pre-check wallet balance for combined privateSend fee
      setState(s => ({ ...s, message: 'Checking wallet balance...' }))
      await checkBalance(client, activeAddress, microAlgos + FEES.privateSend)

      setState(s => ({ ...s, message: 'Deriving deposit key...' }))
      const masterKey = await deriveMasterKey(signData)
      const depositIdx = getNextDepositIndex()
      const note = deriveDeposit(masterKey, depositIdx, microAlgos, 0)

      // Attempt privateSend with retry on stale root (concurrent deposit by another user)
      let txId: string | undefined
      for (let attempt = 1; attempt <= MAX_DEPOSIT_RETRIES; attempt++) {
        try {
          txId = await executePrivateSend(client, activeAddress, transactionSigner, pool, note, microAlgos, destinationAddr)
          break // success
        } catch (err) {
          if (attempt < MAX_DEPOSIT_RETRIES && isStaleRootError(err)) {
            console.warn(`PrivateSend attempt ${attempt} failed (stale root), retrying...`)
            clearTreeCache(pool.appId) // Force fresh sync on retry
            setState(s => ({
              ...s,
              stage: 'depositing',
              message: `Another deposit was processed. Retrying... (${attempt}/${MAX_DEPOSIT_RETRIES})`,
            }))
            continue
          }
          throw err // non-retryable or out of retries
        }
      }

      // Increment deterministic counter (no note to persist — privateSend is atomic deposit+withdraw)
      incrementDepositIndex()

      addToast('success', `${amountAlgo} ALGO sent privately to ${destinationAddr.slice(0, 6)}...${destinationAddr.slice(-4)}`)
      const psNotes = await loadNotes()
      setState({
        stage: 'withdraw_complete',
        message: `${amountAlgo} ALGO sent privately to ${destinationAddr.slice(0, 6)}...${destinationAddr.slice(-4)}`,
        txId: txId!,
        error: null,
        savedNotes: psNotes,
      })
    } catch (err) {
      if (err instanceof PasswordRequiredError) throw err
      const msg = humanizeError(err)
      console.error('Private send error:', err)
      addToast('error', msg)
      setState(s => ({ ...s, stage: 'error', error: msg }))
    }
  }, [activeAddress, transactionSigner, signData, getClient, addToast])

  const reset = useCallback(async () => {
    const notes = await loadNotes()
    setState({
      stage: 'idle',
      message: '',
      txId: null,
      error: null,
      savedNotes: notes,
    })
  }, [])

  const refreshNotes = useCallback(async () => {
    const notes = await loadNotes()
    setState(s => ({ ...s, savedNotes: notes }))
  }, [])

  const rebuildAllTrees = useCallback(async (
    onProgress?: (pool: string, done: boolean) => void,
  ) => {
    await syncAllTreesFromChain(onProgress)
  }, [])

  return {
    ...state,
    deposit,
    withdraw,
    privateSend,
    reset,
    refreshNotes,
    rebuildAllTrees,
    useRelayer: useRelayerState,
    setUseRelayer,
    relayerAvailable,
  }
}
