pragma circom 2.1.6;

/**
 * MiMC Merkle Tree — Membership proof circuit
 *
 * Proves that a leaf (commitment) exists in a Merkle tree of given depth
 * without revealing which leaf it is.
 *
 * Uses MiMC sponge hash (compatible with AVM mimc BN254_MP_110 opcode).
 */

// MiMC constants and hash
include "circomlib/circuits/mimcsponge.circom";

/**
 * HashLeftRight — MiMC hash of two field elements (Merkle tree node hash)
 */
template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;

    component hasher = MiMCSponge(2, 220, 1);
    hasher.ins[0] <== left;
    hasher.ins[1] <== right;
    hasher.k <== 0;
    hash <== hasher.outs[0];
}

/**
 * MerkleTreeChecker — Verifies a Merkle path from leaf to root
 *
 * @param levels - depth of the Merkle tree (e.g., 20 for ~1M leaves)
 */
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels]; // 0 = leaf is on left, 1 = leaf is on right

    component hashers[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    signal mux_left[levels];
    signal mux_right[levels];

    for (var i = 0; i < levels; i++) {
        // Ensure pathIndices[i] is binary
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        hashers[i] = HashLeftRight();

        // If pathIndices[i] == 0: hash(levelHash, pathElement)
        // If pathIndices[i] == 1: hash(pathElement, levelHash)
        // Use signal intermediaries for explicit constraint generation
        mux_left[i] <== levelHashes[i] + (pathElements[i] - levelHashes[i]) * pathIndices[i];
        mux_right[i] <== pathElements[i] + (levelHashes[i] - pathElements[i]) * pathIndices[i];

        hashers[i].left <== mux_left[i];
        hashers[i].right <== mux_right[i];

        levelHashes[i + 1] <== hashers[i].hash;
    }

    // The computed root must match the public root
    root === levelHashes[levels];
}

/**
 * CommitmentHasher — Computes commitment = MiMC(secret, nullifier, amount)
 * and nullifierHash = MiMC(nullifier)
 *
 * The amount is included in the commitment so the ZK proof cryptographically
 * binds to the deposited amount, preventing deposit/withdraw amount mismatches.
 */
template CommitmentHasher() {
    signal input secret;
    signal input nullifier;
    signal input amount;
    signal output commitment;
    signal output nullifierHash;

    // commitment = MiMCSponge([secret, nullifier, amount])
    component commitHasher = MiMCSponge(3, 220, 1);
    commitHasher.ins[0] <== secret;
    commitHasher.ins[1] <== nullifier;
    commitHasher.ins[2] <== amount;
    commitHasher.k <== 0;
    commitment <== commitHasher.outs[0];

    // nullifierHash = MiMCSponge([nullifier])
    component nullHasher = MiMCSponge(1, 220, 1);
    nullHasher.ins[0] <== nullifier;
    nullHasher.k <== 0;
    nullifierHash <== nullHasher.outs[0];
}
