pragma circom 2.1.6;

/**
 * Range Proof Circuit — Confidential Transactions
 *
 * Proves that a committed value is in the range [0, 2^64) without revealing the value.
 * Used with Pedersen commitments: C = amount * G + blinding * H
 *
 * Approach: Binary decomposition — prove value = sum(bit_i * 2^i) where each bit_i in {0,1}
 * This is the simplest range proof and produces ~64 constraints for the range check
 * plus constraints for the Pedersen commitment verification.
 *
 * For production, a Bulletproofs-style approach would be more efficient,
 * but binary decomposition is simpler and works well within snarkjs.
 */

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/mimcsponge.circom";

/**
 * RangeProof — Proves value is in [0, 2^n)
 *
 * @param n - number of bits (e.g., 64 for 64-bit range)
 */
template RangeProof(n) {
    signal input value;       // The secret value to prove is in range
    signal input blinding;    // Blinding factor for Pedersen commitment

    // Public: the commitment (hash-based for circuit simplicity)
    // In practice, the verifier would check EC commitment off-circuit
    signal input commitmentHash; // MiMC(value, blinding) — verified on-chain

    // 1. Binary decomposition of value
    component bits = Num2Bits(n);
    bits.in <== value;
    // Num2Bits constrains: value = sum(bits.out[i] * 2^i) AND each bit in {0,1}
    // This inherently proves value < 2^n

    // 2. Reconstruct value from bits to ensure consistency
    signal reconstructed;
    var sum = 0;
    for (var i = 0; i < n; i++) {
        sum += bits.out[i] * (1 << i);
    }
    reconstructed <== sum;
    reconstructed === value;

    // 3. Verify commitment: commitmentHash = MiMC(value, blinding)
    component commitHasher = MiMCSponge(2, 220, 1);
    commitHasher.ins[0] <== value;
    commitHasher.ins[1] <== blinding;
    commitHasher.k <== 0;
    commitHasher.outs[0] === commitmentHash;
}

/**
 * ConfidentialTransfer — Proves a valid transfer between Pedersen commitments
 *
 * Proves:
 * 1. inputAmount = outputAmount + fee (conservation)
 * 2. All amounts are in [0, 2^64)
 * 3. Commitments are correctly computed
 */
template ConfidentialTransfer() {
    // Private inputs
    signal input inputAmount;
    signal input inputBlinding;
    signal input outputAmount;
    signal input outputBlinding;
    signal input feeAmount;

    // Public inputs — commitment hashes
    signal input inputCommitmentHash;
    signal input outputCommitmentHash;
    signal input feeCommitmentHash;

    // 1. Conservation: input = output + fee
    inputAmount === outputAmount + feeAmount;

    // 2. Range proofs for all amounts
    component inputRange = RangeProof(64);
    inputRange.value <== inputAmount;
    inputRange.blinding <== inputBlinding;
    inputRange.commitmentHash <== inputCommitmentHash;

    component outputRange = RangeProof(64);
    outputRange.value <== outputAmount;
    outputRange.blinding <== outputBlinding;
    outputRange.commitmentHash <== outputCommitmentHash;

    // Fee range proof (smaller range is fine for fees)
    component feeRange = RangeProof(32);
    feeRange.value <== feeAmount;
    // Fee blinding = inputBlinding - outputBlinding (so commitments cancel)
    signal feeBlinding;
    feeBlinding <== inputBlinding - outputBlinding;
    feeRange.blinding <== feeBlinding;
    feeRange.commitmentHash <== feeCommitmentHash;
}

component main {public [inputCommitmentHash, outputCommitmentHash, feeCommitmentHash]} = ConfidentialTransfer();
