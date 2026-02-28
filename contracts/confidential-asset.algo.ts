import { Contract } from '@algorandfoundation/tealscript';

class ConfidentialAsset extends Contract {
  assetId = GlobalStateKey<uint64>({ key: 'asset_id' });
  totalDeposited = GlobalStateKey<uint64>({ key: 'total_dep' });
  totalWithdrawn = GlobalStateKey<uint64>({ key: 'total_wd' });

  // Box storage: balance commitments (BN254 G1 points, 64 bytes each)
  balances = BoxMap<Address, bytes>({ prefix: 'bal' });

  createApplication(assetId: uint64): void {
    this.assetId.value = assetId;
    this.totalDeposited.value = 0;
    this.totalWithdrawn.value = 0;
  }

  /**
   * Shield — deposit public funds, create a Pedersen commitment.
   * Commitment = amount * G + blinding * H (64-byte BN254 G1 point)
   */
  shield(commitment: bytes, amount: uint64): void {
    assert(len(commitment) === 64);

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

    if (this.balances(this.txn.sender).exists) {
      // Add to existing: C_new = C_old + C_deposit via BN254 ec_add
      const existing = this.balances(this.txn.sender).value;
      const newCommitment = ecAdd('BN254g1', existing, commitment);
      this.balances(this.txn.sender).value = newCommitment;
    } else {
      this.balances(this.txn.sender).value = commitment;
    }

    this.totalDeposited.value = this.totalDeposited.value + amount;
    log(concat(hex('736869656c64'), commitment));
  }

  /**
   * Confidential transfer — transfer between shielded balances with hidden amount.
   * Range proofs verified by LogicSig in atomic group.
   */
  confidentialTransfer(
    recipient: Address,
    senderNewCommitment: bytes,
    recipientNewCommitment: bytes,
    transferCommitment: bytes,
  ): void {
    assert(len(senderNewCommitment) === 64);
    assert(len(recipientNewCommitment) === 64);
    assert(len(transferCommitment) === 64);

    // Verify sender has a balance
    assert(this.balances(this.txn.sender).exists);

    // On-chain commitment arithmetic:
    // senderOld = senderNew + transferCommitment
    const senderOld = this.balances(this.txn.sender).value;
    const computedSenderOld = ecAdd('BN254g1', senderNewCommitment, transferCommitment);
    assert(senderOld === computedSenderOld);

    // recipientNew = recipientOld + transferCommitment
    if (this.balances(recipient).exists) {
      const recipientOld = this.balances(recipient).value;
      const computedRecipientNew = ecAdd('BN254g1', recipientOld, transferCommitment);
      assert(recipientNewCommitment === computedRecipientNew);
    }

    // LogicSig verifies range proofs
    assert(this.txn.groupIndex > 0);

    this.balances(this.txn.sender).value = senderNewCommitment;
    this.balances(recipient).value = recipientNewCommitment;

    log(hex('7472616e73666572'));
  }

  /**
   * Unshield — withdraw from shielded balance to public.
   */
  unshield(amount: uint64, newCommitment: bytes): void {
    assert(len(newCommitment) === 64);
    assert(this.balances(this.txn.sender).exists);

    // Update or delete balance
    if (newCommitment === rawBytes(bzero(64))) {
      this.balances(this.txn.sender).delete();
    } else {
      this.balances(this.txn.sender).value = newCommitment;
    }

    if (this.assetId.value === 0) {
      sendPayment({ receiver: this.txn.sender, amount: amount, fee: 0 });
    } else {
      sendAssetTransfer({
        assetReceiver: this.txn.sender,
        assetAmount: amount,
        xferAsset: AssetID.fromUint64(this.assetId.value),
        fee: 0,
      });
    }

    this.totalWithdrawn.value = this.totalWithdrawn.value + amount;
    log(concat(hex('756e736869656c64'), itob(amount)));
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

export default ConfidentialAsset;
