# Cryptography

## View/Spend Key Derivation

```mermaid
graph TD
    WS[Wallet signData<br/>or PBKDF2 password] -->|"MiMC(sig)"| MK[Master Key<br/>BN254 scalar]
    MK -->|"HKDF-SHA256<br/>info='privacy-pool-view-key-v1'"| VK[View Private Key<br/>X25519, 32 bytes]
    VK -->|"X25519 scalar mult"| VP[View Public Key<br/>32 bytes]
    MK -->|"MiMC(mk, 2i)"| SK["Spend Secrets<br/>secret_i, nullifier_i"]

    VP --> ADDR["Privacy Address<br/>priv1..."]
    MK -.->|"Cannot derive MK from VK"| VK

    style MK fill:#e91e63,color:#fff
    style VK fill:#2196F3,color:#fff
    style VP fill:#4CAF50,color:#fff
    style SK fill:#e91e63,color:#fff
```

The view key can decrypt HPKE envelopes to see note contents (amounts, leaf indices) but cannot spend notes. The master key is required for spending (deriving secrets and nullifiers).

## HPKE Envelope Format

```mermaid
graph LR
    subgraph "Envelope (190 bytes, in txn note field)"
        V["version<br/>1B"]
        S["suite<br/>1B"]
        EK["encapsulated<br/>key 32B"]
        CT["ciphertext<br/>92B"]
        VT["viewTag<br/>32B"]
        VE["viewEphemeral<br/>32B"]
    end

    subgraph "Plaintext (76 bytes, encrypted)"
        SEC["secret 32B"]
        NUL["nullifier 32B"]
        DEN["denomination 8B"]
        LI["leafIndex 4B"]
    end

    CT -.->|"ChaCha20-Poly1305<br/>decrypt"| SEC & NUL & DEN & LI
```

HPKE suite: X25519 + HKDF-SHA256 + ChaCha20-Poly1305. View tag enables fast scanning (ECDH check) before full HPKE decryption.

## Chain Scanning Flow

```mermaid
sequenceDiagram
    participant User
    participant Scanner
    participant Indexer
    participant HPKE

    User->>Scanner: scanForNotes(viewKeypair)
    Scanner->>Indexer: Search txns for pool app IDs
    loop For each txn with note >= 190 bytes
        Scanner->>HPKE: checkViewTag(envelope, viewPrivKey)
        alt View tag matches
            Scanner->>HPKE: decryptNote(envelope, viewPrivKey)
            HPKE-->>Scanner: {secret, nullifier, denomination, leafIndex}
            Scanner->>Scanner: Verify commitment = MiMC(secret, nullifier, denom)
            Scanner->>Scanner: Add to recovered notes
        else Tag mismatch
            Scanner->>Scanner: Skip (fast reject)
        end
    end
    Scanner-->>User: Recovered notes merged with localStorage
```

## Privacy Address Format

```
priv1... (bech32-encoded)
┌─────────┬──────────┬───────────────┬───────────────┐
│ version │ network  │ algo_pubkey   │ view_pubkey   │
│  (1B)   │  (1B)    │   (32B)       │   (32B)       │
└─────────┴──────────┴───────────────┴───────────────┘
         Total payload: 66 bytes
```

Share your `priv1...` address to receive private transfers. Senders decode it to get your Algorand address (for on-chain recipient) and view public key (for HPKE encryption). Recipients scan the chain with their view key to discover notes.
