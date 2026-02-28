/**
 * @algo-privacy/stealth — Background Scanner
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
  sleep,
} from '@algo-privacy/core';
import { checkStealthAddress } from './keys.js';
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
    const currentRound = this.lastScannedRound + 1000n; // Would get from algod
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
    const result = await checkStealthAddress(
      announcement.ephemeralPubKey,
      // We need to derive the stealth pub key from the address
      // In production, the announcement would include the stealth pub key
      { x: 0n, y: 0n }, // placeholder
      this.keys.viewingKey,
      this.keys.spendingKey,
      announcement.viewTag,
    );

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
   * One-shot scan: scan all announcements and return found payments.
   * Useful for wallet recovery or initial sync.
   */
  async scanAll(fromRound: bigint = 0n, toRound?: bigint): Promise<StealthPaymentFound[]> {
    const target = toRound ?? fromRound + 1000000n; // Would get from algod
    const announcements = await this.registry.getAnnouncements(fromRound, target);
    const found: StealthPaymentFound[] = [];

    for (const announcement of announcements) {
      const result = await checkStealthAddress(
        announcement.ephemeralPubKey,
        { x: 0n, y: 0n }, // placeholder
        this.keys.viewingKey,
        this.keys.spendingKey,
        announcement.viewTag,
      );

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
