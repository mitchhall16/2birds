pragma circom 2.1.6;

/**
 * Combined PrivateSend Circuit
 *
 * Proves a deposit insertion AND withdrawal in one proof, saving a full
 * verifier call (~0.228 ALGO) compared to two separate proofs.
 *
 * Specifically:
 * 1. commitment = MiMC(secret, nullifier, amount) is correctly computed
 * 2. nullifierHash = MiMC(nullifier) is correctly computed
 * 3. The commitment was inserted at leafIndex: empty leaf → newRoot
 * 4. The slot was previously empty: 0 at leafIndex → oldRoot
 * 5. Proof is bound to recipient, relayer, fee, and amount (anti-frontrun)
 *
 * Since the insertion proof already proves the commitment is in the tree
 * at the new root, we skip a separate withdrawal-side MerkleTreeChecker.
 *
 * Public inputs (9): oldRoot, newRoot, commitment, leafIndex,
 *                    nullifierHash, recipient, relayer, fee, amount
 * Private inputs:    secret, nullifier, pathElements[16]
 *
 * ~44K constraints for depth 16
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

template PrivateSend(levels) {
    // Public inputs
    signal input oldRoot;
    signal input newRoot;
    signal input commitment;
    signal input leafIndex;
    signal input nullifierHash;
    signal input recipient;
    signal input relayer;
    signal input fee;
    signal input amount;

    // Private inputs
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];

    // 1. Compute commitment and nullifier hash
    component hasher = CommitmentHasher();
    hasher.secret <== secret;
    hasher.nullifier <== nullifier;
    hasher.amount <== amount;

    // 2. Verify commitment matches
    hasher.commitment === commitment;

    // 3. Verify nullifier hash matches
    hasher.nullifierHash === nullifierHash;

    // 4. Convert leafIndex to binary path indices
    component indexBits = Num2Bits(levels);
    indexBits.in <== leafIndex;

    // 5. Verify new root: commitment at leafIndex with pathElements → must equal newRoot
    component newTree = MerkleTreeChecker(levels);
    newTree.leaf <== commitment;
    newTree.root <== newRoot;
    for (var i = 0; i < levels; i++) {
        newTree.pathElements[i] <== pathElements[i];
        newTree.pathIndices[i] <== indexBits.out[i];
    }

    // 6. Verify old root: 0 (empty leaf) at same leafIndex → must equal oldRoot
    component oldTree = MerkleTreeChecker(levels);
    oldTree.leaf <== 0;
    oldTree.root <== oldRoot;
    for (var i = 0; i < levels; i++) {
        oldTree.pathElements[i] <== pathElements[i];
        oldTree.pathIndices[i] <== indexBits.out[i];
    }

    // 7. Bind proof to recipient, relayer, fee, and amount (anti-frontrun)
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
    signal relayerSquare;
    relayerSquare <== relayer * relayer;
    signal feeSquare;
    feeSquare <== fee * fee;
    signal amountSquare;
    amountSquare <== amount * amount;
}

// Instantiate with depth 16 (supports ~65K deposits)
component main {public [oldRoot, newRoot, commitment, leafIndex,
                         nullifierHash, recipient, relayer, fee, amount]}
  = PrivateSend(16);
