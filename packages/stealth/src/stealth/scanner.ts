/**
 * @2birds/stealth — Background Scanner
 *
 * Continuously scans the stealth registry for announcements
 * addressed to the recipient. Uses view tags for fast filtering.
 */

import {
  type StealthAnnouncement,
  type StealthKeys,
  type Scalar,
  type AlgorandAddress,
  type NetworkConfig,
  derivePubKey,
  ecMul,
  ecAdd,
  BN254_G,
  sleep,
} from '@2birds/core';
import { stealthPubKeyToAddress } from './keys.js';
import { StealthRegistry, type RegistryConfig } from './registry.js';

/** Event emitted when a stealth payment is found */
export interface StealthPaymentFound {
  announcement: StealthAnnouncement;
  stealthPrivKey: Scalar;
  stealthAddress: AlgorandAddress;
}

/** Scanner configuration */
export interface ScannerConfig {
  registry: RegistryConfig;
  keys: StealthKeys;
  pollIntervalMs?: number; // default: 4000 (one Algorand round)
  startRound?: bigint;
}

/**
 * StealthScanner — background service that scans for incoming stealth payments.
 */
export class StealthScanner {
  private registry: StealthRegistry;
  private keys: StealthKeys;
  private pollInterval: number;
  private lastScannedRound: bigint;
  private running = false;
  private listeners: ((payment: StealthPaymentFound) => void)[] = [];

  constructor(config: ScannerConfig) {
    this.registry = new StealthRegistry(config.registry);
    this.keys = config.keys;
    this.pollInterval = config.pollIntervalMs ?? 4000;
    this.lastScannedRound = config.startRound ?? 0n;
  }

  /** Register a listener for found payments */
  onPaymentFound(listener: (payment: StealthPaymentFound) => void): void {
    this.listeners.push(listener);
  }

  /** Remove a listener */
  removeListener(listener: (payment: StealthPaymentFound) => void): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  /** Start scanning in the background */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.running) {
      try {
        await this.scanNewAnnouncements();
      } catch (err) {
        console.error('Scanner error:', err);
      }
      await sleep(this.pollInterval);
    }
  }

  /** Stop the scanner */
  stop(): void {
    this.running = false;
  }

  /** Get the last scanned round */
  getLastScannedRound(): bigint {
    return this.lastScannedRound;
  }

  /** Scan for new announcements since the last scanned round */
  private async scanNewAnnouncements(): Promise<void> {
    const currentRound = await this.registry.getCurrentRound();
    if (currentRound <= this.lastScannedRound) return;

    const announcements = await this.registry.getAnnouncements(
      this.lastScannedRound + 1n,
      currentRound,
    );

    for (const announcement of announcements) {
      await this.processAnnouncement(announcement);
    }

    this.lastScannedRound = currentRound;
  }

  /** Check if an announcement is addressed to us */
  private async processAnnouncement(announcement: StealthAnnouncement): Promise<void> {
    const result = await this.checkAnnouncementOwnership(announcement);

    if (result.isOwner && result.stealthPrivKey !== undefined) {
      const payment: StealthPaymentFound = {
        announcement,
        stealthPrivKey: result.stealthPrivKey,
        stealthAddress: announcement.stealthAddress,
      };

      for (const listener of this.listeners) {
        try {
          listener(payment);
        } catch (err) {
          console.error('Listener error:', err);
        }
      }
    }
  }

  /**
   * Derive the expected stealth public key from the announcement's ephemeral key
   * and our viewing/spending keys, then compare the resulting Algorand address
   * with the announcement's stealth address.
   */
  private async checkAnnouncementOwnership(announcement: StealthAnnouncement): Promise<{
    isOwner: boolean;
    stealthPrivKey?: Scalar;
  }> {
    // Compute shared secret: s = hash(viewing_priv * ephemeral_pub)
    // Then derive expected stealth pub key: P = spending_pub + s*G
    // checkStealthAddress does this internally and compares against the passed-in stealthPubKey.
    // We first derive the expected stealth pub key to pass it in correctly.
    const spendingPub = derivePubKey(this.keys.spendingKey);
    const dhPoint = ecMul(announcement.ephemeralPubKey, this.keys.viewingKey);

    // Hash the DH point to get the shared secret (same as hashSharedSecret in keys.ts)
    const pointBytes = new Uint8Array(64);
    const xBytes = new Uint8Array(32);
    const yBytes = new Uint8Array(32);
    let xVal = dhPoint.x;
    let yVal = dhPoint.y;
    for (let i = 31; i >= 0; i--) { xBytes[i] = Number(xVal & 0xffn); xVal >>= 8n; }
    for (let i = 31; i >= 0; i--) { yBytes[i] = Number(yVal & 0xffn); yVal >>= 8n; }
    pointBytes.set(xBytes, 0);
    pointBytes.set(yBytes, 32);
    const domain = new TextEncoder().encode('algo-stealth-v1');
    const hashInput = new Uint8Array(domain.length + pointBytes.length);
    hashInput.set(domain, 0);
    hashInput.set(pointBytes, domain.length);
    const hashBuf = await crypto.subtle.digest('SHA-256', hashInput);
    const hashBytes = new Uint8Array(hashBuf);
    let sharedSecret = 0n;
    for (let i = 0; i < 32; i++) sharedSecret = (sharedSecret << 8n) | BigInt(hashBytes[i]);

    // Quick view tag check
    if (announcement.viewTag !== undefined) {
      const computedTag = Number(sharedSecret & 0xffn);
      if (computedTag !== announcement.viewTag) {
        return { isOwner: false };
      }
    }

    // Derive expected stealth pub key: P = spending_pub + sharedSecret * G
    const stealthOffset = ecMul(BN254_G, sharedSecret);
    const expectedPub = ecAdd(spendingPub, stealthOffset);

    // Derive the Algorand address from the expected stealth pub key
    const expectedAddress = await stealthPubKeyToAddress(expectedPub);

    if (expectedAddress === announcement.stealthAddress) {
      // Derive stealth private key: p = spending_priv + sharedSecret
      const { scalarMod } = await import('@2birds/core');
      const stealthPrivKey = scalarMod(this.keys.spendingKey + sharedSecret);
      return { isOwner: true, stealthPrivKey };
    }

    return { isOwner: false };
  }

  /**
   * One-shot scan: scan all announcements and return found payments.
   * Useful for wallet recovery or initial sync.
   */
  async scanAll(fromRound: bigint = 0n, toRound?: bigint): Promise<StealthPaymentFound[]> {
    const target = toRound ?? await this.registry.getCurrentRound();
    const announcements = await this.registry.getAnnouncements(fromRound, target);
    const found: StealthPaymentFound[] = [];

    for (const announcement of announcements) {
      const result = await this.checkAnnouncementOwnership(announcement);

      if (result.isOwner && result.stealthPrivKey !== undefined) {
        found.push({
          announcement,
          stealthPrivKey: result.stealthPrivKey,
          stealthAddress: announcement.stealthAddress,
        });
      }
    }

    return found;
  }
}
