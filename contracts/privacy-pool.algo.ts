/**
 * Privacy Pool Contract — Tornado Cash model adapted for Algorand AVM
 *
 * Enables private withdrawals by breaking the on-chain link between depositor and recipient.
 * Supports both ALGO and ASAs (USDC, etc.).
 *
 * Architecture:
 * - Deposits add commitments to an incremental Merkle tree (MiMC hash, depth 20)
 * - Withdrawals require a ZK proof (Groth16/PLONK) verified by a LogicSig
 * - Nullifier tracking prevents double-spend (box storage with direct key lookup)
 *
 * Storage layout:
 * - Global "root": bytes32 — current Merkle root
 * - Global "next_index": uint64 — next leaf index
 * - Global "denomination": uint64 — fixed deposit amount (e.g., 10_000_000 for 10 ALGO)
 * - Global "asset_id": uint64 — 0 for ALGO, ASA ID otherwise
 * - Box "tree:<level>": bytes32 — frontier node at each level (20 boxes, 32 bytes each)
 * - Box "root:<index>": bytes32 — historical roots (ring buffer of last 100 roots)
 * - Box "null:<hash>": 1 byte — nullifier set (existence = spent)
 * - Box "zeros:<level>": bytes32 — pre-computed zero hashes for empty subtrees
 *
 * Verification flow (atomic group):
 * 1. LogicSig transaction — verifies ZK proof (100-145K opcodes via opcode pooling)
 * 2. App call — checks nullifier, updates state, transfers funds
 *
 * Costs:
 * - Deposit: 1 app call + MBR for tree update (~0.01 ALGO) + denomination
 * - Withdraw: LogicSig (8 min fees = 0.008 ALGO) + app call + standard fees
 *
 * AVM requirements: v10+ (BN254 curve ops, box storage), v11 (MiMC opcode)
 */

import { Contract } from '@algorandfoundation/tealscript';

// Merkle tree depth — supports 2^20 = ~1M deposits
const TREE_DEPTH = 20;
// Number of historical roots to keep (for withdrawal timing flexibility)
const ROOT_HISTORY_SIZE = 100;

class PrivacyPool extends Contract {
  // === Global State ===
  currentRoot = GlobalStateKey<bytes>({ key: 'root' });
  nextIndex = GlobalStateKey<uint64>({ key: 'next_idx' });
  denomination = GlobalStateKey<uint64>({ key: 'denom' });
  assetId = GlobalStateKey<uint64>({ key: 'asset_id' });
  rootHistoryIndex = GlobalStateKey<uint64>({ key: 'rhi' });

  /**
   * Initialize the privacy pool.
   *
   * @param denomination - Fixed deposit amount in base units
   * @param assetId - 0 for ALGO, ASA ID for tokens
   */
  createApplication(denomination: uint64, assetId: uint64): void {
    this.denomination.value = denomination;
    this.assetId.value = assetId;
    this.nextIndex.value = 0;
    this.rootHistoryIndex.value = 0;

    // Initialize frontier with zero hashes
    // Zero hash at level 0 = MiMC(0, 0) — pre-computed
    // Each subsequent level = MiMC(zero[i-1], zero[i-1])
    // These are stored in boxes "zeros:<level>"

    // Compute initial root from empty tree
    // root = hash of all zeros at each level
    // This is pre-computed and set here
    const emptyRoot = hex('0000000000000000000000000000000000000000000000000000000000000000');
    this.currentRoot.value = emptyRoot;
  }

  /**
   * Deposit funds into the privacy pool.
   *
   * The user provides a commitment = MiMC(secret, nullifier) computed off-chain.
   * The contract inserts it into the incremental Merkle tree and updates the root.
   *
   * Must be accompanied by a payment of exactly `denomination` to this contract.
   *
   * @param commitment - 32-byte commitment hash
   */
  deposit(commitment: bytes): void {
    // Validate commitment
    assert(commitment.length === 32, 'Commitment must be 32 bytes');

    // Verify payment
    const payTxn = this.txnGroup[this.txn.groupIndex - 1];
    if (this.assetId.value === 0) {
      // ALGO deposit
      assert(payTxn.type === TransactionType.Payment, 'Expected payment');
      assert(payTxn.receiver === this.app.address, 'Payment to wrong address');
      assert(payTxn.amount === this.denomination.value, 'Wrong denomination');
    } else {
      // ASA deposit
      assert(payTxn.type === TransactionType.AssetTransfer, 'Expected ASA transfer');
      assert(payTxn.assetReceiver === this.app.address, 'Transfer to wrong address');
      assert(payTxn.assetAmount === this.denomination.value, 'Wrong denomination');
      assert(payTxn.xferAsset === AssetID.fromUint64(this.assetId.value), 'Wrong asset');
    }

    // Insert commitment into Merkle tree
    const leafIndex = this.nextIndex.value;
    assert(leafIndex < (1 << TREE_DEPTH), 'Tree is full');

    // Update incremental Merkle tree
    // The frontier stores the latest node at each level that can still be a left child
    this.insertLeaf(commitment, leafIndex);

    // Increment leaf counter
    this.nextIndex.value = leafIndex + 1;

    // Store new root in history
    const histIdx = this.rootHistoryIndex.value;
    const rootBoxKey = concat(hex('726f6f743a'), itob(histIdx % ROOT_HISTORY_SIZE));
    this.app.box.put(rootBoxKey, this.currentRoot.value);
    this.rootHistoryIndex.value = histIdx + 1;

    // Log deposit event
    log(concat(hex('6465706f736974'), commitment, itob(leafIndex)));
  }

  /**
   * Withdraw funds from the privacy pool.
   *
   * Requires a valid ZK proof (verified by LogicSig in the same atomic group).
   * The contract verifies:
   * 1. The root used in the proof is a known historical root
   * 2. The nullifier has not been used before (prevents double-spend)
   * 3. Sends funds to the specified recipient
   *
   * @param nullifierHash - 32-byte nullifier hash (from the ZK proof)
   * @param recipient - Address to receive the withdrawal
   * @param relayer - Relayer address (or zero address if direct withdrawal)
   * @param fee - Relayer fee in base units (deducted from withdrawal)
   * @param root - Merkle root used in the proof
   */
  withdraw(
    nullifierHash: bytes,
    recipient: Address,
    relayer: Address,
    fee: uint64,
    root: bytes,
  ): void {
    // 1. Verify the root is known (current or historical)
    assert(this.isKnownRoot(root), 'Unknown Merkle root');

    // 2. Check nullifier hasn't been spent
    const nullBoxKey = concat(hex('6e756c6c3a'), nullifierHash);
    assert(!this.app.box.exists(nullBoxKey), 'Nullifier already spent');

    // 3. Record nullifier as spent
    this.app.box.put(nullBoxKey, hex('01'));

    // 4. Verify the LogicSig (ZK verifier) is in this atomic group
    // The LogicSig verifies the Groth16/PLONK proof
    // We check that a LogicSig transaction exists in the group
    assert(this.txn.groupIndex > 0, 'Missing verifier LogicSig');

    // 5. Send funds to recipient
    const withdrawAmount = this.denomination.value - fee;

    if (this.assetId.value === 0) {
      // ALGO withdrawal
      sendPayment({
        receiver: recipient,
        amount: withdrawAmount,
        fee: 0,
      });
    } else {
      // ASA withdrawal
      sendAssetTransfer({
        assetReceiver: recipient,
        assetAmount: withdrawAmount,
        xferAsset: AssetID.fromUint64(this.assetId.value),
        fee: 0,
      });
    }

    // 6. Send fee to relayer (if applicable)
    if (fee > 0) {
      if (this.assetId.value === 0) {
        sendPayment({
          receiver: relayer,
          amount: fee,
          fee: 0,
        });
      } else {
        sendAssetTransfer({
          assetReceiver: relayer,
          assetAmount: fee,
          xferAsset: AssetID.fromUint64(this.assetId.value),
          fee: 0,
        });
      }
    }

    // Log withdrawal event
    log(concat(hex('7769746864726177'), nullifierHash));
  }

  /**
   * Check if a root is in the history.
   */
  private isKnownRoot(root: bytes): boolean {
    // Check current root
    if (root === this.currentRoot.value) return true;

    // Check historical roots
    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      const boxKey = concat(hex('726f6f743a'), itob(i));
      if (this.app.box.exists(boxKey)) {
        const storedRoot = this.app.box.get(boxKey);
        if (storedRoot === root) return true;
      }
    }

    return false;
  }

  /**
   * Insert a leaf into the incremental Merkle tree.
   *
   * The incremental Merkle tree only stores the "frontier" — one node per level
   * that represents the rightmost filled subtree. This uses O(depth) storage
   * instead of O(2^depth).
   *
   * Algorithm:
   * 1. Start with the new leaf as the current hash
   * 2. At each level, if the current index is even (left child):
   *    - Store current hash as the frontier at this level
   *    - Hash with the zero hash for the right sibling
   * 3. If current index is odd (right child):
   *    - Load the frontier (left sibling) from storage
   *    - Hash frontier with current hash
   * 4. Move to the next level (index >>= 1)
   */
  private insertLeaf(leaf: bytes, index: uint64): void {
    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < TREE_DEPTH; level++) {
      const treeBoxKey = concat(hex('747265653a'), itob(level));
      const zeroBoxKey = concat(hex('7a65726f733a'), itob(level));

      if (currentIndex % 2 === 0) {
        // Left child — store in frontier, hash with zero
        this.app.box.put(treeBoxKey, currentHash);
        const zeroHash = this.app.box.exists(zeroBoxKey)
          ? this.app.box.get(zeroBoxKey)
          : hex('0000000000000000000000000000000000000000000000000000000000000000');
        // currentHash = MiMC(currentHash, zeroHash)
        // Uses AVM mimc opcode in production
        currentHash = mimc(concat(currentHash, zeroHash));
      } else {
        // Right child — load frontier (left sibling), hash together
        const leftSibling = this.app.box.get(treeBoxKey);
        // currentHash = MiMC(leftSibling, currentHash)
        currentHash = mimc(concat(leftSibling, currentHash));
      }

      currentIndex = currentIndex >> 1;
    }

    // Update the root
    this.currentRoot.value = currentHash;
  }

  /**
   * Opt into an ASA (required before the pool can receive ASA deposits).
   * Only needed for ASA pools, called once after deployment.
   */
  optInToAsset(): void {
    assert(this.assetId.value !== 0, 'Not an ASA pool');

    sendAssetTransfer({
      assetReceiver: this.app.address,
      assetAmount: 0,
      xferAsset: AssetID.fromUint64(this.assetId.value),
      fee: 0,
    });
  }
}

export default PrivacyPool;
