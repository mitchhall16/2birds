# privacy-sdk

Zero-knowledge privacy primitives for Algorand. Stealth addresses, privacy pools, confidential transactions, and shielded transfers — all powered by Groth16 ZK proofs and BN254 curve operations on the AVM.

## Architecture

```mermaid
graph TB
    subgraph "Client SDK (TypeScript)"
        CLI[CLI Tool]
        POOL[Pool Package]
        STEALTH[Stealth Package]
        SHIELDED[Shielded Package]
        CONF[Confidential Package]
        CORE[Core: BN254 + MiMC]
    end

    subgraph "ZK Circuits (Circom)"
        WC[Withdraw Circuit<br/>~30K constraints]
        RP[Range Proof Circuit<br/>~10K constraints]
        ST[Shielded Transfer Circuit<br/>~150K constraints]
    end

    subgraph "Algorand AVM"
        PP[Privacy Pool Contract]
        SR[Stealth Registry Contract]
        SP[Shielded Pool Contract]
        CA[Confidential Asset Contract]
        LS[LogicSig Groth16 Verifier<br/>BN254 pairing check]
    end

    subgraph "Infrastructure"
        REL[Relayer Server]
    end

    CLI --> POOL & STEALTH & SHIELDED
    POOL --> CORE
    STEALTH --> CORE
    SHIELDED --> CORE
    CONF --> CORE

    POOL -->|snarkjs| WC
    CONF -->|snarkjs| RP
    SHIELDED -->|snarkjs| ST

    POOL -->|atomic group| PP
    POOL -->|proof| LS
    STEALTH --> SR
    SHIELDED --> SP
    CONF --> CA

    REL -->|submit withdrawal| PP
    LS -->|verify in group| PP
```

## Privacy Primitives

```mermaid
graph LR
    subgraph "Phase 1: Stealth Addresses"
        A1[Sender] -->|ECDH + BN254| A2[Stealth Address]
        A2 -->|one-time address| A3[Receiver Scans]
    end

    subgraph "Phase 2: Privacy Pool"
        B1[Deposit] -->|MiMC commitment| B2[Merkle Tree]
        B2 -->|ZK proof| B3[Withdraw to Any Address]
    end

    subgraph "Phase 3: Confidential Txns"
        C1[Amount] -->|Pedersen commitment| C2[Hidden Balance]
        C2 -->|range proof| C3[Verified Transfer]
    end

    subgraph "Phase 4: Shielded Transfers"
        D1[Full Privacy] -->|2-in/2-out UTXO| D2[ZK Proof]
        D2 -->|nullifiers + commitments| D3[Private Transfer]
    end
```

## How the Privacy Pool Works

```mermaid
sequenceDiagram
    participant User
    participant SDK
    participant Circuit
    participant LogicSig
    participant Contract

    Note over User,Contract: DEPOSIT
    User->>SDK: deposit(amount)
    SDK->>SDK: secret = random(), nullifier = random()
    SDK->>SDK: commitment = MiMC(secret, nullifier)
    SDK->>Contract: payment(amount) + deposit(commitment)
    Contract->>Contract: Insert commitment into Merkle tree
    Contract-->>User: DepositNote {secret, nullifier, leafIndex}

    Note over User,Contract: WITHDRAW (days/weeks later)
    User->>SDK: withdraw(note, recipient)
    SDK->>SDK: Build Merkle path for leaf
    SDK->>Circuit: Generate Groth16 proof
    Note right of Circuit: Proves: I know a valid leaf<br/>without revealing which one
    Circuit-->>SDK: proof {pi_a, pi_b, pi_c}
    SDK->>LogicSig: Encode proof as args
    SDK->>Contract: Atomic group: [LogicSig verify, app call withdraw]
    LogicSig->>LogicSig: BN254 pairing check (~145K opcodes)
    Contract->>Contract: Check nullifier not spent
    Contract->>Contract: Check root is known
    Contract->>User: Send funds to recipient
```

## Groth16 Verification on AVM

```mermaid
graph TD
    subgraph "LogicSig (8 inner txn fees = 0.008 ALGO)"
        A[Extract proof from args<br/>pi_a, pi_b, pi_c] --> B[Extract public signals<br/>root, nullifierHash, recipient, relayer, fee]
        B --> C[Compute vk_x = IC_0 + sum of public_i * IC_i<br/>ec_scalar_mul + ec_add on BN254g1]
        C --> D[Pairing check<br/>e&#40-A, B&#41 * e&#40alpha, beta&#41 * e&#40vk_x, gamma&#41 * e&#40C, delta&#41 == 1]
        D -->|pass| E[Approve transaction]
        D -->|fail| F[Reject]
    end

    subgraph "App Call (same atomic group)"
        G[Check nullifier not in box storage] --> H[Check root in history]
        H --> I[Transfer denomination to recipient]
        I --> J[Record nullifier as spent]
    end

    E -.->|atomic group| G
```

## Merkle Tree (Incremental, Depth 20)

```mermaid
graph TB
    ROOT[Root = MiMC&#40H_L, H_R&#41]
    ROOT --- L19[Level 19]
    ROOT --- R19[Level 19]
    L19 --- L18a[Level 18]
    L19 --- R18a[Level 18]
    R19 --- L18b["zero[19]"]

    L18a --- LEAF0["Leaf 0<br/>commitment"]
    L18a --- LEAF1["Leaf 1<br/>commitment"]
    R18a --- LEAF2["Leaf 2<br/>commitment"]
    R18a --- EMPTY["zero[0]"]

    style LEAF0 fill:#4CAF50,color:#fff
    style LEAF1 fill:#4CAF50,color:#fff
    style LEAF2 fill:#4CAF50,color:#fff
    style EMPTY fill:#666,color:#fff
    style L18b fill:#666,color:#fff
    style ROOT fill:#2196F3,color:#fff
```

## Project Structure

```
privacy-sdk/
├── packages/
│   ├── core/           # BN254 curve ops, MiMC hash, types
│   ├── pool/           # Privacy pool deposit/withdraw
│   ├── stealth/        # Stealth address protocol (ERC-5564)
│   ├── shielded/       # Full UTXO privacy system
│   ├── confidential/   # Hidden amounts (Pedersen commitments)
│   ├── circuits/       # Circuit artifacts & metadata
│   ├── relayer/        # HTTP relayer for private withdrawals
│   └── cli/            # Command-line interface
├── contracts/
│   ├── privacy-pool.algo.ts      # Tornado Cash model for Algorand
│   ├── stealth-registry.algo.ts  # Stealth meta-address registry
│   ├── shielded-pool.algo.ts     # Full privacy UTXO pool
│   └── confidential-asset.algo.ts # Hidden transfer amounts
├── circuits/
│   ├── withdraw.circom           # Withdrawal proof (~30K constraints)
│   ├── merkleTree.circom         # MiMC Merkle membership
│   ├── range-proof.circom        # Amount range proofs
│   ├── shielded-transfer.circom  # Full shielded transfer (~150K constraints)
│   └── build/                    # Compiled WASM, zkeys, vkeys
├── demo.ts             # Interactive demo (no blockchain needed)
└── test-proof.ts       # Real Groth16 proof generation & verification
```

## Quick Start

```bash
# Install dependencies
npm install

# Run the interactive demo (no blockchain needed)
npx tsx demo.ts

# Generate and verify a real ZK proof
npx tsx test-proof.ts

# Build ZK circuits (requires circom + snarkjs)
cd circuits && bash build.sh
```

## ZK Proof Test Output

```
════════════════════════════════════════════════════════════
  Real ZK Proof — Withdrawal Circuit
════════════════════════════════════════════════════════════

  Initializing MiMC sponge (circomlib-compatible, 220 rounds)...
  Creating deposit (secret + nullifier)...
  Commitment: 76232192545840885598...
  NullifierHash: 68893552353962002315...
  Building Merkle tree (depth 20, 1 leaf)...
  Merkle root: 20340347044506301858...
  Generating Groth16 proof (this takes 5-15 seconds)...
  Proof generated in 2.1s
  Proof size: pi_a(2), pi_b(4), pi_c(2) = 8 field elements
  Verifying proof...
  Proof valid: true
```

## On-Chain Costs

| Operation | Cost | Details |
|-----------|------|---------|
| Deposit | ~0.01 ALGO | App call + MBR for Merkle tree update |
| Withdraw | ~0.008 ALGO | LogicSig verification (8 min fees for opcode budget) |
| Stealth Register | ~0.05 ALGO | Box MBR for meta-address (128 bytes) |
| Stealth Send | Standard | Normal Algorand transfer to one-time address |

## Tech Stack

- **Circuits**: Circom 2.1.6 + snarkjs (Groth16)
- **Curve**: BN254 (alt_bn128) — native AVM v10+ support
- **Hash**: MiMC Sponge (220 rounds, x^5 Feistel) — compatible with circomlib
- **Contracts**: TealScript (compiles to TEAL for AVM)
- **SDK**: TypeScript monorepo (npm workspaces)
- **Proving**: snarkjs WASM prover (~2s proof generation)
- **Verification**: BN254 pairing check via AVM opcodes (`ec_add`, `ec_scalar_mul`, `ec_pairing_check`)

## AVM Requirements

- AVM v10+ for BN254 curve operations
- AVM v11 for MiMC opcode
- Box storage for Merkle tree, nullifier set, root history
- LogicSig opcode pooling (145K opcodes via 8 inner transaction fees)

## License

MIT
