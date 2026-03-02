# Security Considerations

## Known Limitations

### Merkle Root Trust Assumption

**Severity:** Medium (mitigated)

**Description:** The on-chain contract accepts the MiMC Merkle root submitted by the client during deposit. It does not verify that the submitted root correctly reflects the new tree state after inserting the commitment. An attacker could theoretically:

1. Deposit once with a valid commitment
2. Submit a fake Merkle root that includes a second forged commitment
3. Withdraw twice — once for the real commitment, once for the forged one

**Why this can't be fully fixed on AVM:** MiMC hashing operates over the BN254 scalar field, which requires modular arithmetic over a 254-bit prime. The AVM does not provide native BN254 field operations, making on-chain MiMC computation infeasible within opcode budget limits. An alternative dual-tree architecture (SHA256 on-chain + MiMC off-chain) would require a major protocol rewrite.

**Mitigations in place:**
- **ZK proof verification (Fix 1):** The contract verifies that the preceding transaction is a call to the correct ZK verifier app, and that the public signals (root, nullifierHash, amount) match the withdrawal parameters. An attacker must produce a valid ZK proof for any forged commitment.
- **Amount binding in circuit:** The commitment is `MiMC(secret, nullifier, amount)`, binding the proof to the deposited amount. An attacker cannot withdraw more than the pool denomination per commitment.
- **Real deposit required:** The attacker must deposit real ALGO to execute the first legitimate deposit, making the attack unprofitable if mitigations hold.
- **Nullifier tracking:** Each commitment can only be withdrawn once (nullifier is marked as spent on-chain).

### Withdrawal Privacy (Sender Linkage)

**Severity:** Medium (mitigated with relayer)

**Description:** Without a relayer, the depositor's wallet signs the withdrawal transaction, creating an on-chain link between deposit and withdrawal addresses.

**Mitigation:** A relayer service submits withdrawals on behalf of users, so the on-chain sender is the relayer address. The ZK proof ensures only the legitimate note holder can initiate a withdrawal, even through the relayer.

### Deposit Linkability

**Severity:** Low (by design)

**Description:** Deposits are fully linkable on-chain — the commitment and leaf index are visible in the deposit transaction. Anyone watching the chain can see which commitment was deposited, when, and by which wallet. Privacy is only achieved at withdrawal time, when the ZK proof hides which commitment is being spent. This is standard for Tornado Cash-style protocols.

**Mitigation:** The ZK withdrawal proof reveals nothing about which deposit is being spent. Combined with fixed denomination tiers and the anonymity set of all deposits in the pool, this provides strong withdrawal privacy.

### Timing Correlation

**Severity:** Low

**Description:** If a user deposits and withdraws in quick succession with no other pool activity, an observer can correlate the transactions by timing alone.

**Mitigation:** Users are warned in the UI to wait for other pool activity before withdrawing. Fixed denomination tiers increase the anonymity set.

## Architecture

- **ZK Proofs:** Groth16 over BN254, verified by an on-chain verifier app
- **Commitment scheme:** `MiMC(secret, nullifier, amount)` — binds each commitment to a specific deposit amount
- **Merkle tree:** 16-level MiMC Merkle tree maintained off-chain, root stored on-chain
- **Nullifiers:** `MiMC(nullifier)` stored on-chain to prevent double-spending
- **Encryption:** AES-256-GCM with keys derived from wallet signatures (ARC-0047 signData) or PBKDF2 passwords

## Reporting

If you discover a security vulnerability, please report it responsibly by opening a private issue or contacting the maintainers directly.
