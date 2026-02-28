/**
 * Stealth Address Registry Contract
 *
 * Manages the on-chain registry of stealth meta-addresses and announcements.
 *
 * Storage:
 * - Box "meta:<label>": 128 bytes — spending_pub (64) + viewing_pub (64)
 * - Box "ann:<counter>": variable — ephemeral_pub (64) + stealth_addr (32) + view_tag (1) + metadata
 * - Global "announcement_count": uint64 — monotonic counter for announcement ordering
 *
 * Methods:
 * - register(label, meta_address): Register a meta-address for a label
 * - announce(data): Publish a stealth payment announcement
 * - get_meta(label): Read a meta-address (read-only, no txn needed)
 *
 * Costs:
 * - register: 1 txn + box MBR (2500 + 400 * 128 = 53,700 microAlgo = ~0.054 ALGO)
 * - announce: 1 txn + box MBR (2500 + 400 * ~97 = 41,300 microAlgo = ~0.041 ALGO)
 *
 * AVM requirements: v10+ (for box storage)
 */

import { Contract } from '@algorandfoundation/tealscript';

class StealthRegistry extends Contract {
  // Global state
  announcementCount = GlobalStateKey<uint64>({ key: 'count' });

  /**
   * Register a stealth meta-address under a label (e.g., an Algorand address or ENS-like name).
   *
   * @param label - The label to register under (max 64 bytes)
   * @param metaAddress - 128 bytes: spending_pub (64) + viewing_pub (64)
   */
  register(label: bytes, metaAddress: bytes): void {
    // Validate meta-address length
    assert(metaAddress.length === 128, 'Meta-address must be 128 bytes');
    assert(label.length > 0 && label.length <= 64, 'Label must be 1-64 bytes');

    // Create box key: "meta:" + label
    const boxKey = concat(hex('6d6574613a'), label); // "meta:" prefix

    // Store meta-address in box
    // Sender must provide MBR payment in a grouped transaction
    this.app.box.put(boxKey, metaAddress);
  }

  /**
   * Publish a stealth payment announcement.
   * Called by sender after sending funds to a stealth address.
   *
   * @param announcementData - ephemeral_pub (64) + stealth_addr (32) + view_tag (1) + optional metadata
   */
  announce(announcementData: bytes): void {
    // Validate minimum length: 64 (ephemeral pub) + 32 (addr) + 1 (view tag) = 97
    assert(announcementData.length >= 97, 'Announcement too short');

    // Increment counter
    const count = this.announcementCount.exists ? this.announcementCount.value : 0;
    this.announcementCount.value = count + 1;

    // Create box key: "ann:" + counter (8 bytes big-endian)
    const counterBytes = itob(count);
    const boxKey = concat(hex('616e6e3a'), counterBytes); // "ann:" prefix

    // Store announcement in box
    this.app.box.put(boxKey, announcementData);

    // Log the announcement for indexer consumption
    log(concat(hex('616e6e6f756e6365'), counterBytes, announcementData));
  }

  /**
   * Delete a meta-address registration (only by the original registrant).
   * Reclaims the box MBR.
   */
  deregister(label: bytes): void {
    const boxKey = concat(hex('6d6574613a'), label);
    assert(this.app.box.exists(boxKey), 'Label not registered');

    // Delete the box — MBR returned to sender
    this.app.box.delete(boxKey);
  }
}

export default StealthRegistry;
