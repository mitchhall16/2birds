/**
 * @algo-privacy/stealth — Key generation and stealth address derivation
 *
 * Implements ERC-5564-style stealth addresses adapted for Algorand using BN254 curve.
 *
 * Protocol:
 * 1. Recipient publishes meta-address: (spending_pub, viewing_pub) on-chain
 * 2. Sender generates ephemeral keypair (r, R = r*G)
 * 3. Sender computes shared secret: s = hash(r * viewing_pub)
 * 4. Sender computes stealth public key: P = spending_pub + s*G
 * 5. Sender publishes R (ephemeral pub) as announcement
 * 6. Recipient scans: for each R, compute s = hash(viewing_priv * R)
 * 7. If spending_pub + s*G matches a known stealth address, it's theirs
 * 8. Recipient derives stealth private key: p = spending_priv + s
 */

import {
  type BN254Point,
  type Scalar,
  type StealthMetaAddress,
  type StealthKeys,
  randomScalar,
  derivePubKey,
  ecMul,
  ecAdd,
  scalarMod,
  BN254_G,
  BN254_SCALAR_ORDER,
  encodePoint,
  bigintToBytes32,
  bytes32ToBigint,
} from '@algo-privacy/core';

/** Generate a new stealth keypair (spending + viewing) */
export function generateStealthKeys(): StealthKeys & { metaAddress: StealthMetaAddress } {
  const spendingKey = randomScalar();
  const viewingKey = randomScalar();

  return {
    spendingKey,
    viewingKey,
    metaAddress: {
      spendingPubKey: derivePubKey(spendingKey),
      viewingPubKey: derivePubKey(viewingKey),
    },
  };
}

/** Encode a meta-address to a portable string format: "st:algo:<hex spending pub><hex viewing pub>" */
export function encodeMetaAddress(meta: StealthMetaAddress): string {
  const spendBytes = encodePoint(meta.spendingPubKey);
  const viewBytes = encodePoint(meta.viewingPubKey);
  const combined = new Uint8Array(128);
  combined.set(spendBytes, 0);
  combined.set(viewBytes, 64);
  const hex = Array.from(combined).map(b => b.toString(16).padStart(2, '0')).join('');
  return `st:algo:${hex}`;
}

/** Decode a meta-address from its string representation */
export function decodeMetaAddress(encoded: string): StealthMetaAddress {
  if (!encoded.startsWith('st:algo:')) {
    throw new Error('Invalid stealth meta-address format');
  }
  const hex = encoded.slice(8);
  if (hex.length !== 256) {
    throw new Error('Invalid meta-address length');
  }
  const bytes = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return {
    spendingPubKey: {
      x: bytes32ToBigint(bytes.slice(0, 32)),
      y: bytes32ToBigint(bytes.slice(32, 64)),
    },
    viewingPubKey: {
      x: bytes32ToBigint(bytes.slice(64, 96)),
      y: bytes32ToBigint(bytes.slice(96, 128)),
    },
  };
}

/**
 * Sender: Generate a stealth address for a recipient.
 * Returns the stealth public key and the ephemeral public key (to publish as announcement).
 */
export async function generateStealthAddress(recipientMeta: StealthMetaAddress): Promise<{
  stealthPubKey: BN254Point;
  ephemeralPubKey: BN254Point;
  viewTag: number;
}> {
  // Generate ephemeral keypair
  const ephemeralPriv = randomScalar();
  const ephemeralPub = derivePubKey(ephemeralPriv);

  // Shared secret via ECDH: s = hash(ephemeral_priv * viewing_pub)
  const dhPoint = ecMul(recipientMeta.viewingPubKey, ephemeralPriv);
  const sharedSecret = await hashSharedSecret(dhPoint);

  // Stealth public key: P = spending_pub + s*G
  const stealthOffset = ecMul(BN254_G, sharedSecret);
  const stealthPubKey = ecAdd(recipientMeta.spendingPubKey, stealthOffset);

  // View tag: first byte of the shared secret (for fast scanning optimization)
  const viewTag = Number(sharedSecret & 0xffn);

  return { stealthPubKey, ephemeralPubKey: ephemeralPub, viewTag };
}

/**
 * Recipient: Check if a stealth address belongs to them.
 * If it does, return the stealth private key for spending.
 */
export async function checkStealthAddress(
  ephemeralPubKey: BN254Point,
  stealthPubKey: BN254Point,
  viewingKey: Scalar,
  spendingKey: Scalar,
  viewTag?: number,
): Promise<{ isOwner: boolean; stealthPrivKey?: Scalar }> {
  // Compute shared secret: s = hash(viewing_priv * ephemeral_pub)
  const dhPoint = ecMul(ephemeralPubKey, viewingKey);
  const sharedSecret = await hashSharedSecret(dhPoint);

  // Quick check using view tag (optimization — avoids expensive EC ops for non-matching)
  if (viewTag !== undefined) {
    const computedTag = Number(sharedSecret & 0xffn);
    if (computedTag !== viewTag) {
      return { isOwner: false };
    }
  }

  // Compute expected stealth public key: P = spending_pub + s*G
  const spendingPub = derivePubKey(spendingKey);
  const stealthOffset = ecMul(BN254_G, sharedSecret);
  const expectedPub = ecAdd(spendingPub, stealthOffset);

  // Check if it matches
  if (expectedPub.x === stealthPubKey.x && expectedPub.y === stealthPubKey.y) {
    // Derive stealth private key: p = spending_priv + s
    const stealthPrivKey = scalarMod(spendingKey + sharedSecret);
    return { isOwner: true, stealthPrivKey };
  }

  return { isOwner: false };
}

/** Hash a DH point to produce a shared secret scalar */
async function hashSharedSecret(dhPoint: BN254Point): Promise<Scalar> {
  const pointBytes = encodePoint(dhPoint);
  // Domain separation: prepend "algo-stealth-v1"
  const domain = new TextEncoder().encode('algo-stealth-v1');
  const input = new Uint8Array(domain.length + pointBytes.length);
  input.set(domain, 0);
  input.set(pointBytes, domain.length);

  const hash = await crypto.subtle.digest('SHA-256', input);
  return scalarMod(bytes32ToBigint(new Uint8Array(hash)));
}

/**
 * Derive an Algorand-compatible address from a BN254 stealth public key.
 * Since Algorand uses Ed25519, we need a bridging mechanism:
 * The stealth private key is used to derive an Ed25519 keypair deterministically.
 */
export function stealthKeyToAlgorandAccount(stealthPrivKey: Scalar): {
  address: string;
  sk: Uint8Array;
} {
  // Use the stealth private key as seed for an Algorand account
  // Hash to 32 bytes to use as Ed25519 seed
  const seed = bigintToBytes32(stealthPrivKey);
  // algosdk expects a 32-byte seed
  const account = {
    addr: '', // Will be set below
    sk: new Uint8Array(64), // Ed25519 secret key is 64 bytes (seed + public key)
  };

  // For now, use algosdk's account generation from seed
  // In production, this would use the seed directly for deterministic derivation
  const mnemonic = seedToMnemonic(seed);
  const recovered = mnemonicToAccount(mnemonic);
  return { address: recovered.addr, sk: recovered.sk };
}

/** Helper: convert 32-byte seed to a mnemonic (simplified — production would use proper BIP39) */
function seedToMnemonic(seed: Uint8Array): string {
  // Use algosdk's built-in mnemonic from secret key
  // We create a deterministic account from the seed
  const tempAccount = { sk: new Uint8Array(64), addr: '' };
  tempAccount.sk.set(seed, 0);
  // In production, derive the Ed25519 keypair properly
  return '';
}

function mnemonicToAccount(_mnemonic: string): { addr: string; sk: Uint8Array } {
  // Placeholder — in production, derive deterministic Ed25519 keypair from BN254 stealth key
  return { addr: '', sk: new Uint8Array(64) };
}
