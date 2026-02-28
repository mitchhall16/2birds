import { Contract } from '@algorandfoundation/tealscript';

const TREE_DEPTH = 20;
const ROOT_HISTORY_SIZE = 100;

class ShieldedPool extends Contract {
  currentRoot = GlobalStateKey<bytes>({ key: 'root' });
  nextIndex = GlobalStateKey<uint64>({ key: 'next_idx' });
  assetId = GlobalStateKey<uint64>({ key: 'asset_id' });
  rootHistoryIndex = GlobalStateKey<uint64>({ key: 'rhi' });

  // Box storage
  treeFrontier = BoxMap<uint64, bytes>({ prefix: 'tree' });
  nullifiers = BoxMap<bytes, bytes>({ prefix: 'null' });
  rootHistory = BoxMap<uint64, bytes>({ prefix: 'root' });
  zeroHashes = BoxMap<uint64, bytes>({ prefix: 'zero' });

  createApplication(assetId: uint64): void {
    this.assetId.value = assetId;
    this.nextIndex.value = 0;
    this.rootHistoryIndex.value = 0;
    this.currentRoot.value = bzero(32);
  }

  /**
   * Shield — deposit funds, create a shielded UTXO note.
   */
  shield(commitment: bytes, amount: uint64): void {
    assert(len(commitment) === 32);

    const payTxn = this.txnGroup[this.txn.groupIndex - 1];
    if (this.assetId.value === 0) {
      verifyPayTxn(payTxn, {
        receiver: this.app.address,
        amount: amount,
      });
    } else {
      verifyAssetTransferTxn(payTxn, {
        assetReceiver: this.app.address,
        assetAmount: amount,
        xferAsset: AssetID.fromUint64(this.assetId.value),
      });
    }

    const idx = this.nextIndex.value;
    assert(idx < (1 << TREE_DEPTH));
    this.insertLeaf(commitment, idx);
    this.nextIndex.value = idx + 1;

    const histIdx = this.rootHistoryIndex.value;
    this.rootHistory(histIdx % ROOT_HISTORY_SIZE).value = this.currentRoot.value;
    this.rootHistoryIndex.value = histIdx + 1;

    log(concat(hex('736869656c64'), commitment));
  }

  /**
   * Transfer — consume input notes, create output notes (2-in/2-out).
   * ZK proof in LogicSig verifies membership, nullifiers, conservation, range proofs.
   */
  transfer(
    nullifierHash1: bytes,
    nullifierHash2: bytes,
    outputCommitment1: bytes,
    outputCommitment2: bytes,
    proof_root: bytes,
  ): void {
    assert(this.isKnownRoot(proof_root));
    assert(this.txn.groupIndex > 0);

    // Check and record nullifiers
    assert(!this.nullifiers(nullifierHash1).exists);
    this.nullifiers(nullifierHash1).value = hex('01');

    if (len(nullifierHash2) > 0) {
      assert(!this.nullifiers(nullifierHash2).exists);
      this.nullifiers(nullifierHash2).value = hex('01');
    }

    // Insert output commitments
    let idx = this.nextIndex.value;
    this.insertLeaf(outputCommitment1, idx);
    idx = idx + 1;

    if (len(outputCommitment2) > 0) {
      this.insertLeaf(outputCommitment2, idx);
      idx = idx + 1;
    }

    this.nextIndex.value = idx;

    const histIdx = this.rootHistoryIndex.value;
    this.rootHistory(histIdx % ROOT_HISTORY_SIZE).value = this.currentRoot.value;
    this.rootHistoryIndex.value = histIdx + 1;

    log(hex('7472616e73666572'));
  }

  /**
   * Unshield — withdraw funds by consuming a shielded note.
   */
  unshield(
    nullifierHash: bytes,
    recipient: Address,
    amount: uint64,
    changeCommitment: bytes,
    proof_root: bytes,
  ): void {
    assert(len(nullifierHash) === 32);
    assert(this.isKnownRoot(proof_root));
    assert(this.txn.groupIndex > 0);

    assert(!this.nullifiers(nullifierHash).exists);
    this.nullifiers(nullifierHash).value = hex('01');

    // If there's a change note, add it back to the tree
    if (len(changeCommitment) === 32) {
      const idx = this.nextIndex.value;
      this.insertLeaf(changeCommitment, idx);
      this.nextIndex.value = idx + 1;

      const histIdx = this.rootHistoryIndex.value;
      this.rootHistory(histIdx % ROOT_HISTORY_SIZE).value = this.currentRoot.value;
      this.rootHistoryIndex.value = histIdx + 1;
    }

    if (this.assetId.value === 0) {
      sendPayment({ receiver: recipient, amount: amount, fee: 0 });
    } else {
      sendAssetTransfer({
        assetReceiver: recipient,
        assetAmount: amount,
        xferAsset: AssetID.fromUint64(this.assetId.value),
        fee: 0,
      });
    }

    log(concat(hex('756e736869656c64'), nullifierHash));
  }

  private isKnownRoot(root: bytes): boolean {
    if (root === this.currentRoot.value) return true;
    for (let i = 0; i < ROOT_HISTORY_SIZE; i += 1) {
      if (this.rootHistory(i as uint64).exists) {
        if (this.rootHistory(i as uint64).value === root) return true;
      }
    }
    return false;
  }

  private insertLeaf(leaf: bytes, index: uint64): void {
    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const lvl = level as uint64;
      if (currentIndex % 2 === 0) {
        this.treeFrontier(lvl).value = currentHash;
        const zeroHash = this.zeroHashes(lvl).exists
          ? this.zeroHashes(lvl).value
          : bzero(32);
        currentHash = rawBytes(sha256(concat(currentHash, zeroHash)));
      } else {
        const leftSibling = this.treeFrontier(lvl).value;
        currentHash = rawBytes(sha256(concat(leftSibling, currentHash)));
      }
      currentIndex = currentIndex / 2;
    }

    this.currentRoot.value = currentHash;
  }

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

export default ShieldedPool;
