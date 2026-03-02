pragma circom 2.1.6;

/**
 * Privacy Pool Withdrawal Circuit
 *
 * Proves that the prover knows a (secret, nullifier) pair such that:
 * 1. commitment = MiMC(secret, nullifier, amount) exists in the Merkle tree (root)
 * 2. nullifierHash = MiMC(nullifier) is correctly computed
 * 3. The proof is bound to a specific recipient, relayer, and amount (prevents front-running)
 *
 * Public inputs:  root, nullifierHash, recipient, relayer, fee, amount
 * Private inputs: secret, nullifier, pathElements[16], pathIndices[16]
 *
 * ~23K constraints for depth 16
 */

include "merkleTree.circom";

template Withdraw(levels) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input recipient;    // Algorand address as field element (prevents front-running)
    signal input relayer;      // Relayer address as field element
    signal input fee;          // Relayer fee (public so it can't be inflated)
    signal input amount;       // Deposit amount in microAlgos (binds proof to deposited value)

    // Private inputs
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Compute commitment and nullifier hash (commitment includes amount)
    component hasher = CommitmentHasher();
    hasher.secret <== secret;
    hasher.nullifier <== nullifier;
    hasher.amount <== amount;

    // 2. Verify nullifier hash matches
    hasher.nullifierHash === nullifierHash;

    // 3. Verify Merkle tree membership
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== hasher.commitment;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // 4. Bind proof to recipient, relayer, and amount (square them to add constraints)
    // This prevents front-running: the proof is only valid for this specific
    // recipient/relayer/fee/amount combination
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
component main {public [root, nullifierHash, recipient, relayer, fee, amount]} = Withdraw(16);
