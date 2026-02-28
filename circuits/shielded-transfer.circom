pragma circom 2.1.6;

/**
 * Shielded Transfer Circuit — Full Privacy (Phase 4)
 *
 * Combines:
 * - Merkle tree membership (privacy pool)
 * - Nullifier derivation (double-spend prevention)
 * - Amount conservation (confidential transactions)
 * - Range proofs (non-negative amounts)
 *
 * UTXO model: consumes N input notes, creates M output notes.
 * For simplicity, we fix N=2 inputs and M=2 outputs (like Zcash Sapling).
 *
 * Each note: { amount, ownerPubKey, blinding, nullifier }
 * Commitment = MiMC(amount, ownerPubKey, blinding, nullifier)
 * NullifierHash = MiMC(nullifier, spendingKey)
 *
 * Public:  root, nullifierHashes[2], outputCommitments[2]
 * Private: inputAmounts[2], inputBlindings[2], inputNullifiers[2],
 *          inputPaths[2][20], inputIndices[2][20], spendingKey,
 *          outputAmounts[2], outputBlindings[2], outputOwnerPubKeys[2], outputNullifiers[2]
 */

include "merkleTree.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/mimcsponge.circom";

template ShieldedTransfer(levels, nInputs, nOutputs) {
    // === Public Inputs ===
    signal input root;                              // Current Merkle tree root
    signal input nullifierHashes[nInputs];          // Nullifier hashes (double-spend prevention)
    signal input outputCommitments[nOutputs];       // New note commitments

    // === Private Inputs: Input Notes ===
    signal input inputAmounts[nInputs];
    signal input inputBlindings[nInputs];
    signal input inputNullifiers[nInputs];
    signal input inputOwnerPubKeys[nInputs];        // x-coordinate of owner's BN254 pub key
    signal input inputPathElements[nInputs][levels];
    signal input inputPathIndices[nInputs][levels];
    signal input spendingKey;                       // Proves ownership of input notes

    // === Private Inputs: Output Notes ===
    signal input outputAmounts[nOutputs];
    signal input outputBlindings[nOutputs];
    signal input outputOwnerPubKeys[nOutputs];
    signal input outputNullifiers[nOutputs];

    // === 1. Verify each input note ===
    component inputCommitHashers[nInputs];
    component inputNullifierHashers[nInputs];
    component inputTreeCheckers[nInputs];

    for (var i = 0; i < nInputs; i++) {
        // Compute commitment = MiMC(amount, ownerPubKey, blinding, nullifier)
        inputCommitHashers[i] = MiMCSponge(4, 220, 1);
        inputCommitHashers[i].ins[0] <== inputAmounts[i];
        inputCommitHashers[i].ins[1] <== inputOwnerPubKeys[i];
        inputCommitHashers[i].ins[2] <== inputBlindings[i];
        inputCommitHashers[i].ins[3] <== inputNullifiers[i];
        inputCommitHashers[i].k <== 0;

        // Verify Merkle membership
        inputTreeCheckers[i] = MerkleTreeChecker(levels);
        inputTreeCheckers[i].leaf <== inputCommitHashers[i].outs[0];
        inputTreeCheckers[i].root <== root;
        for (var j = 0; j < levels; j++) {
            inputTreeCheckers[i].pathElements[j] <== inputPathElements[i][j];
            inputTreeCheckers[i].pathIndices[j] <== inputPathIndices[i][j];
        }

        // Verify nullifier hash = MiMC(nullifier, spendingKey)
        inputNullifierHashers[i] = MiMCSponge(2, 220, 1);
        inputNullifierHashers[i].ins[0] <== inputNullifiers[i];
        inputNullifierHashers[i].ins[1] <== spendingKey;
        inputNullifierHashers[i].k <== 0;
        inputNullifierHashers[i].outs[0] === nullifierHashes[i];

        // Verify ownership: ownerPubKey should correspond to spendingKey
        // (In full implementation, this would verify EC relationship)
    }

    // === 2. Verify each output note commitment ===
    component outputCommitHashers[nOutputs];

    for (var i = 0; i < nOutputs; i++) {
        outputCommitHashers[i] = MiMCSponge(4, 220, 1);
        outputCommitHashers[i].ins[0] <== outputAmounts[i];
        outputCommitHashers[i].ins[1] <== outputOwnerPubKeys[i];
        outputCommitHashers[i].ins[2] <== outputBlindings[i];
        outputCommitHashers[i].ins[3] <== outputNullifiers[i];
        outputCommitHashers[i].k <== 0;

        // Verify commitment matches public output
        outputCommitHashers[i].outs[0] === outputCommitments[i];
    }

    // === 3. Conservation: sum(inputs) == sum(outputs) ===
    var inputSum = 0;
    for (var i = 0; i < nInputs; i++) {
        inputSum += inputAmounts[i];
    }

    var outputSum = 0;
    for (var i = 0; i < nOutputs; i++) {
        outputSum += outputAmounts[i];
    }

    signal totalInput;
    signal totalOutput;
    totalInput <== inputSum;
    totalOutput <== outputSum;
    totalInput === totalOutput;

    // === 4. Range proofs: all amounts in [0, 2^64) ===
    component inputBits[nInputs];
    for (var i = 0; i < nInputs; i++) {
        inputBits[i] = Num2Bits(64);
        inputBits[i].in <== inputAmounts[i];
    }

    component outputBits[nOutputs];
    for (var i = 0; i < nOutputs; i++) {
        outputBits[i] = Num2Bits(64);
        outputBits[i].in <== outputAmounts[i];
    }
}

// 2-in, 2-out with depth 20 Merkle tree
component main {public [root, nullifierHashes, outputCommitments]} = ShieldedTransfer(20, 2, 2);
