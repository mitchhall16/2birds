# Security Model

## Anti-Correlation Protections

```mermaid
graph LR
    subgraph "Timing Defenses"
        BW["Batch Windows<br/>:00 :15 :30 :45"]
        CD["Operation Cooldown<br/>2 min between ops"]
        WJ["Withdraw Jitter<br/>5-30s random delay"]
    end

    subgraph "Pattern Defenses"
        ST["Soak Time<br/>≥3 deposits after yours<br/>before withdraw allowed"]
        CL["Cluster Detection<br/>Warning after 3 ops/session"]
        FD["Fixed Denominations<br/>0.1 / 0.5 / 1.0 ALGO"]
    end

    subgraph "Infrastructure Defenses"
        DR["Dual Relayers<br/>Random selection per op"]
        IH["IP Hashing<br/>SHA-256, raw IP never stored"]
        HN["HPKE Notes<br/>Encrypted on-chain backup"]
    end
```

## Trust Model

- **ZK proofs**: PLONK on BN254 — same cryptographic hardness as Groth16
- **Contract immutability**: `setPlonkVerifiers` is one-shot — verifier addresses are permanently locked after first call. The creator cannot swap verifiers.
- **Relayer trust**: Liveness only — relayers can censor (refuse to relay) but cannot steal funds or break privacy. If one relayer is down, the other is used automatically.
- **Relayer privacy**: IPs hashed with SHA-256 before rate-limit storage, raw IPs never persisted
- **Dual relayers**: Frontend randomly picks one per operation — no single operator sees all traffic
- **Frontend integrity**: SRI SHA-384 hashes on all JS/CSS, CSP headers restrict script/connect sources
- **Note recovery**: HPKE-encrypted notes stored on-chain — recoverable with view key even after clearing browser data
- **View key compromise**: If an attacker obtains your view key, they can see note contents but cannot spend. By design for auditability.

## Exploitability Comparison (2birds vs HermesVault)

```mermaid
graph TB
    subgraph "Attack Surface — 2birds"
        T2A["Timing correlation ✅ MITIGATED<br/>Batch windows + jitter + cooldown"]
        T2B["Deposit-withdraw linking ✅ MITIGATED<br/>Relayer breaks tx graph"]
        T2C["Amount correlation ✅ MITIGATED<br/>Fixed denominations + split/combine"]
        T2D["Note loss ✅ MITIGATED<br/>HPKE encrypted on-chain backup"]
        T2E["IP leak ✅ MITIGATED<br/>Relayer hashes IPs (SHA-256)"]
        T2F["Sybil deposits ✅ MITIGATED<br/>Soak time (3 deposits) + cluster warning"]
        T2G["Anonymity set size ⚠️ INHERENT<br/>Depends on pool usage"]
        T2H["Frontend tampering ✅ MITIGATED<br/>SRI hashes + CSP headers"]
    end

    subgraph "Attack Surface — HermesVault"
        H2A["Timing correlation ⚠️ VULNERABLE<br/>No jitter, no batch windows"]
        H2B["Deposit-withdraw linking ⚠️ VULNERABLE<br/>User submits own tx from own wallet"]
        H2C["Amount correlation ✅ MITIGATED<br/>Fixed denominations"]
        H2D["Note loss ⚠️ VULNERABLE<br/>localStorage only — clear browser = lose funds"]
        H2E["IP leak ⚠️ VULNERABLE<br/>User IP visible to RPC node"]
        H2F["Sybil deposits ⚠️ VULNERABLE<br/>No soak time enforcement"]
        H2G["Anonymity set size ⚠️ INHERENT<br/>Depends on pool usage"]
        H2H["Frontend tampering ⚠️ VULNERABLE<br/>No SRI or CSP"]
    end

    style T2A fill:#4CAF50,color:#fff
    style T2B fill:#4CAF50,color:#fff
    style T2C fill:#4CAF50,color:#fff
    style T2D fill:#4CAF50,color:#fff
    style T2E fill:#4CAF50,color:#fff
    style T2F fill:#4CAF50,color:#fff
    style T2G fill:#FF9800,color:#fff
    style T2H fill:#4CAF50,color:#fff

    style H2A fill:#FF9800,color:#fff
    style H2B fill:#FF9800,color:#fff
    style H2C fill:#4CAF50,color:#fff
    style H2D fill:#FF9800,color:#fff
    style H2E fill:#FF9800,color:#fff
    style H2F fill:#FF9800,color:#fff
    style H2G fill:#FF9800,color:#fff
    style H2H fill:#FF9800,color:#fff
```

| Attack Vector | 2birds | HermesVault |
|---|---|---|
| Timing correlation | **Mitigated** — batch windows, jitter (5-30s), cooldown (2 min) | Vulnerable — no timing defenses |
| Deposit-withdraw linking | **Mitigated** — relayer submits tx, user never touches chain | Vulnerable — user wallet submits withdraw tx |
| IP metadata leak | **Mitigated** — relayer hashes IPs with SHA-256 | Vulnerable — user IP visible to Algorand RPC |
| Note loss risk | **Mitigated** — HPKE encrypted backup in on-chain txn notes | Vulnerable — localStorage only |
| Sybil / immediate withdraw | **Mitigated** — soak time (3 deposits), cluster detection | Vulnerable — no soak enforcement |
| Frontend tampering | **Mitigated** — SRI SHA-384 + CSP headers | Vulnerable — no integrity checks |
| Amount correlation | **Mitigated** — fixed tiers + split/combine | Mitigated — fixed tiers |
| Contract trust | **Equal** — one-shot locked, immutable | Equal — immutable |
| Anonymity set | Depends on usage | Depends on usage |

**2birds mitigates 7/8 attack vectors. HermesVault mitigates 2/8.**
