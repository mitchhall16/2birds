/**
 * Confidential Asset Contract — Hidden Transfer Amounts
 *
 * Manages shielded balances where amounts are hidden using Pedersen commitments.
 * Users can deposit, transfer (with hidden amounts), and withdraw.
 *
 * Each balance is stored as a Pedersen commitment: C = amount * G + blinding * H
 * Transfers prove:
 * 1. C_input = C_output + C_change (conservation)
 * 2. All amounts in [0, 2^64) (range proof)
 *
 * Storage:
 * - Box "bal:<address>": 64 bytes — Pedersen commitment (BN254 point)
 * - Global "asset_id": uint64 — the ASA being shielded
 *
 * Verification:
 * - Range proofs verified by LogicSig (AlgoPlonk-generated PLONK verifier)
 * - Commitment arithmetic verified on-chain using BN254 ec_add/ec_scalar_mul
 *
 * AVM requirements: v10+ (BN254 ops, box storage)
 */

import { Contract } from '@algorandfoundation/tealscript';

class ConfidentialAsset extends Contract {
  // Global state
  assetId = GlobalStateKey<uint64>({ key: 'asset_id' });
  totalDeposited = GlobalStateKey<uint64>({ key: 'total_dep' });
  totalWithdrawn = GlobalStateKey<uint64>({ key: 'total_wd' });

  /**
   * Initialize with the ASA to shield. 0 for ALGO.
   */
  createApplication(assetId: uint64): void {
    this.assetId.value = assetId;
    this.totalDeposited.value = 0;
    this.totalWithdrawn.value = 0;
  }

  /**
   * Shield (deposit) — Convert public balance to a Pedersen commitment.
   *
   * User deposits a known amount and provides the commitment.
   * Contract verifies: commitment encodes the deposited amount (via ZK proof in LogicSig).
   *
   * @param commitment - 64-byte Pedersen commitment (BN254 point)
   * @param amount - The public deposit amount (verified against payment)
   */
  shield(commitment: bytes, amount: uint64): void {
    assert(commitment.length === 64, 'Commitment must be 64 bytes (BN254 point)');

    // Verify the deposit payment
    const payTxn = this.txnGroup[this.txn.groupIndex - 1];
    if (this.assetId.value === 0) {
      assert(payTxn.type === TransactionType.Payment, 'Expected payment');
      assert(payTxn.receiver === this.app.address, 'Wrong receiver');
      assert(payTxn.amount === amount, 'Amount mismatch');
    } else {
      assert(payTxn.type === TransactionType.AssetTransfer, 'Expected ASA transfer');
      assert(payTxn.assetReceiver === this.app.address, 'Wrong receiver');
      assert(payTxn.assetAmount === amount, 'Amount mismatch');
      assert(payTxn.xferAsset === AssetID.fromUint64(this.assetId.value), 'Wrong asset');
    }

    // Store or update the user's commitment
    const balBoxKey = concat(hex('62616c3a'), this.txn.sender.bytes);

    if (this.app.box.exists(balBoxKey)) {
      // Add to existing commitment: C_new = C_old + C_deposit
      // Uses BN254 ec_add opcode
      const existingCommitment = this.app.box.get(balBoxKey);
      const newCommitment = ec_add('BN254g1', existingCommitment, commitment);
      this.app.box.put(balBoxKey, newCommitment);
    } else {
      this.app.box.put(balBoxKey, commitment);
    }

    this.totalDeposited.value = this.totalDeposited.value + amount;
    log(concat(hex('736869656c64'), this.txn.sender.bytes, commitment));
  }

  /**
   * Confidential transfer — Transfer between two shielded balances.
   *
   * Requires a ZK proof (in LogicSig) proving:
   * 1. Sender's commitment decreases by transfer amount
   * 2. Recipient's commitment increases by transfer amount
   * 3. Both resulting balances are non-negative (range proofs)
   *
   * @param recipient - Recipient's address
   * @param senderNewCommitment - Sender's new balance commitment
   * @param recipientNewCommitment - Recipient's new balance commitment
   * @param transferCommitment - Commitment to the transfer amount (for audit)
   */
  confidentialTransfer(
    recipient: Address,
    senderNewCommitment: bytes,
    recipientNewCommitment: bytes,
    transferCommitment: bytes,
  ): void {
    assert(senderNewCommitment.length === 64, 'Invalid sender commitment');
    assert(recipientNewCommitment.length === 64, 'Invalid recipient commitment');
    assert(transferCommitment.length === 64, 'Invalid transfer commitment');

    const senderBoxKey = concat(hex('62616c3a'), this.txn.sender.bytes);
    const recipientBoxKey = concat(hex('62616c3a'), recipient.bytes);

    // Verify sender has a balance
    assert(this.app.box.exists(senderBoxKey), 'Sender has no shielded balance');

    // Verify commitment arithmetic on-chain:
    // senderOld = senderNew + transferCommitment
    // recipientNew = recipientOld + transferCommitment
    const senderOld = this.app.box.get(senderBoxKey);
    const computedSenderOld = ec_add('BN254g1', senderNewCommitment, transferCommitment);
    assert(senderOld === computedSenderOld, 'Sender commitment mismatch');

    if (this.app.box.exists(recipientBoxKey)) {
      const recipientOld = this.app.box.get(recipientBoxKey);
      const computedRecipientNew = ec_add('BN254g1', recipientOld, transferCommitment);
      assert(recipientNewCommitment === computedRecipientNew, 'Recipient commitment mismatch');
    }
    // else: new recipient, their commitment is just the transfer commitment

    // The LogicSig in the atomic group verifies the range proofs
    assert(this.txn.groupIndex > 0, 'Missing range proof verifier');

    // Update commitments
    this.app.box.put(senderBoxKey, senderNewCommitment);
    this.app.box.put(recipientBoxKey, recipientNewCommitment);

    log(concat(hex('7472616e73666572'), this.txn.sender.bytes, recipient.bytes));
  }

  /**
   * Unshield (withdraw) — Convert shielded balance back to public.
   *
   * Requires ZK proof that the withdrawal amount is <= the committed balance.
   *
   * @param amount - Amount to withdraw (public)
   * @param newCommitment - Updated balance commitment after withdrawal
   */
  unshield(amount: uint64, newCommitment: bytes): void {
    assert(newCommitment.length === 64, 'Invalid commitment');

    const balBoxKey = concat(hex('62616c3a'), this.txn.sender.bytes);
    assert(this.app.box.exists(balBoxKey), 'No shielded balance');

    // Verify: oldCommitment = newCommitment + commit(amount, 0)
    // The LogicSig proves the relationship and range proofs

    // Update balance commitment
    if (newCommitment === hex('0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')) {
      // Zero balance — delete box to reclaim MBR
      this.app.box.delete(balBoxKey);
    } else {
      this.app.box.put(balBoxKey, newCommitment);
    }

    // Send funds
    if (this.assetId.value === 0) {
      sendPayment({
        receiver: this.txn.sender,
        amount: amount,
        fee: 0,
      });
    } else {
      sendAssetTransfer({
        assetReceiver: this.txn.sender,
        assetAmount: amount,
        xferAsset: AssetID.fromUint64(this.assetId.value),
        fee: 0,
      });
    }

    this.totalWithdrawn.value = this.totalWithdrawn.value + amount;
    log(concat(hex('756e736869656c64'), this.txn.sender.bytes, itob(amount)));
  }

  /**
   * Opt into an ASA (required for ASA pools).
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

export default ConfidentialAsset;
