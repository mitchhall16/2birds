pragma circom 2.1.6;

/**
 * Deposit Insertion Circuit
 *
 * Proves that a commitment was correctly inserted into a Merkle tree at
 * a specific leaf index, transitioning the root from oldRoot to newRoot.
 *
 * Specifically:
 * 1. Recompute root from `commitment` at `leafIndex` using pathElements → must equal newRoot
 * 2. Recompute root from 0 (empty leaf) at `leafIndex` using same pathElements → must equal oldRoot
 * 3. This proves only the leaf at `leafIndex` changed from empty to `commitment`
 *
 * Public inputs:  oldRoot, newRoot, commitment, leafIndex
 * Private inputs: pathElements[16] (sibling hashes along the path)
 *
 * ~42K constraints for depth 16 (~32 MiMCSponge instances)
 */

include "merkleTree.circom";

/**
 * Num2Bits — Convert a number to its binary representation
 * (needed to extract path indices from leafIndex)
 */
template Num2Bits(n) {
    signal input in;
    signal output out[n];

    var lc1 = 0;
    var e2 = 1;
    for (var i = 0; i < n; i++) {
        out[i] <-- (in >> i) & 1;
        out[i] * (out[i] - 1) === 0;
        lc1 += out[i] * e2;
        e2 = e2 + e2;
    }
    lc1 === in;
}

template DepositInsertion(levels) {
    // Public inputs
    signal input oldRoot;
    signal input newRoot;
    signal input commitment;
    signal input leafIndex;

    // Private inputs
    signal input pathElements[levels];

    // Convert leafIndex to binary path indices
    component indexBits = Num2Bits(levels);
    indexBits.in <== leafIndex;

    // 1. Verify new root: hash commitment at leafIndex with pathElements → must equal newRoot
    component newTree = MerkleTreeChecker(levels);
    newTree.leaf <== commitment;
    newTree.root <== newRoot;
    for (var i = 0; i < levels; i++) {
        newTree.pathElements[i] <== pathElements[i];
        newTree.pathIndices[i] <== indexBits.out[i];
    }

    // 2. Verify old root: hash 0 (empty leaf) at same leafIndex with same pathElements → must equal oldRoot
    component oldTree = MerkleTreeChecker(levels);
    oldTree.leaf <== 0;
    oldTree.root <== oldRoot;
    for (var i = 0; i < levels; i++) {
        oldTree.pathElements[i] <== pathElements[i];
        oldTree.pathIndices[i] <== indexBits.out[i];
    }
}

// Instantiate with depth 16 (supports ~65K deposits)
component main {public [oldRoot, newRoot, commitment, leafIndex]} = DepositInsertion(16);
