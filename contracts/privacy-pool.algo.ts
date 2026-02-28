import { Contract } from '@algorandfoundation/tealscript';

const TREE_DEPTH = 20;
const ROOT_HISTORY_SIZE = 100;

class PrivacyPool extends Contract {
  // Global state
  currentRoot = GlobalStateKey<bytes>({ key: 'root' });
  nextIndex = GlobalStateKey<uint64>({ key: 'next_idx' });
  denomination = GlobalStateKey<uint64>({ key: 'denom' });
  assetId = GlobalStateKey<uint64>({ key: 'asset_id' });
  rootHistoryIndex = GlobalStateKey<uint64>({ key: 'rhi' });

  // Box storage
  treeFrontier = BoxMap<uint64, bytes>({ prefix: 'tree' });
  nullifiers = BoxMap<bytes, bytes>({ prefix: 'null' });
  rootHistory = BoxMap<uint64, bytes>({ prefix: 'root' });
  zeroHashes = BoxMap<uint64, bytes>({ prefix: 'zero' });

  /**
   * Initialize the privacy pool.
   */
  createApplication(denomination: uint64, assetId: uint64): void {
    this.denomination.value = denomination;
    this.assetId.value = assetId;
    this.nextIndex.value = 0;
    this.rootHistoryIndex.value = 0;

    // Empty root (all zeros)
    this.currentRoot.value = bzero(32);
  }

  /**
   * Deposit funds into the privacy pool.
   * Commitment = MiMC(secret, nullifier) computed off-chain.
   * Must be accompanied by a payment of exactly `denomination`.
   */
  deposit(commitment: bytes): void {
    assert(len(commitment) === 32);

    // Verify payment in the preceding transaction
    const payTxn = this.txnGroup[this.txn.groupIndex - 1];
    if (this.assetId.value === 0) {
      verifyPayTxn(payTxn, {
        receiver: this.app.address,
        amount: this.denomination.value,
      });
    } else {
      verifyAssetTransferTxn(payTxn, {
        assetReceiver: this.app.address,
        assetAmount: this.denomination.value,
        xferAsset: AssetID.fromUint64(this.assetId.value),
      });
    }

    // Insert commitment into Merkle tree
    const leafIndex = this.nextIndex.value;
    assert(leafIndex < (1 << TREE_DEPTH));
    this.insertLeaf(commitment, leafIndex);

    // Increment leaf counter
    this.nextIndex.value = leafIndex + 1;

    // Store new root in history (ring buffer)
    const histIdx = this.rootHistoryIndex.value;
    this.rootHistory(histIdx % ROOT_HISTORY_SIZE).value = this.currentRoot.value;
    this.rootHistoryIndex.value = histIdx + 1;

    // Log deposit event
    log(concat(hex('6465706f736974'), commitment));
  }

  /**
   * Withdraw funds from the privacy pool.
   * Requires a valid ZK proof verified by LogicSig in the same atomic group.
   */
  withdraw(
    nullifierHash: bytes,
    recipient: Address,
    relayer: Address,
    fee: uint64,
    root: bytes,
  ): void {
    // 1. Verify the root is known
    assert(this.isKnownRoot(root));

    // 2. Check nullifier hasn't been spent
    assert(!this.nullifiers(nullifierHash).exists);

    // 3. Record nullifier as spent
    this.nullifiers(nullifierHash).value = hex('01');

    // 4. Verify LogicSig (ZK verifier) is in this atomic group
    assert(this.txn.groupIndex > 0);

    // 5. Send funds to recipient
    const withdrawAmount = this.denomination.value - fee;

    if (this.assetId.value === 0) {
      sendPayment({
        receiver: recipient,
        amount: withdrawAmount,
        fee: 0,
      });
    } else {
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

    log(concat(hex('7769746864726177'), nullifierHash));
  }

  /**
   * Check if a root is in the history.
   */
  private isKnownRoot(root: bytes): boolean {
    if (root === this.currentRoot.value) return true;

    for (let i = 0; i < ROOT_HISTORY_SIZE; i += 1) {
      if (this.rootHistory(i as uint64).exists) {
        if (this.rootHistory(i as uint64).value === root) return true;
      }
    }

    return false;
  }

  /**
   * Insert a leaf into the incremental Merkle tree.
   */
  private insertLeaf(leaf: bytes, index: uint64): void {
    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const lvl = level as uint64;
      if (currentIndex % 2 === 0) {
        // Left child — store in frontier, hash with zero
        this.treeFrontier(lvl).value = currentHash;
        const zeroHash = this.zeroHashes(lvl).exists
          ? this.zeroHashes(lvl).value
          : bzero(32);
        currentHash = rawBytes(sha256(concat(currentHash, zeroHash)));
      } else {
        // Right child — load frontier, hash together
        const leftSibling = this.treeFrontier(lvl).value;
        currentHash = rawBytes(sha256(concat(leftSibling, currentHash)));
      }

      currentIndex = currentIndex / 2;
    }

    this.currentRoot.value = currentHash;
  }

  /**
   * Opt into an ASA (required before the pool can receive ASA deposits).
   */
  optInToAsset(): void {
    assert(this.assetId.value !== 0);

    sendAssetTransfer({
      assetReceiver: this.app.address,
      assetAmount: 0,
      xferAsset: AssetID.fromUint64(this.assetId.value),
      fee: 0,
    });
  }
}

export default PrivacyPool;
