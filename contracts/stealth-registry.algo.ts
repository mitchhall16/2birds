import { Contract } from '@algorandfoundation/tealscript';

class StealthRegistry extends Contract {
  announcementCount = GlobalStateKey<uint64>({ key: 'count' });

  // Box storage
  metaAddresses = BoxMap<bytes, bytes>({ prefix: 'meta' });
  announcements = BoxMap<uint64, bytes>({ prefix: 'ann' });

  createApplication(): void {
    this.announcementCount.value = 0;
  }

  /**
   * Register a stealth meta-address (spending pub 64B + viewing pub 64B = 128B).
   */
  register(label: bytes, metaAddress: bytes): void {
    assert(len(metaAddress) === 128);
    assert(len(label) > 0);
    this.metaAddresses(label).value = metaAddress;
  }

  /**
   * Publish a stealth payment announcement.
   * Data: ephemeral_pub (64B) + stealth_addr (32B) + view_tag (1B) + metadata
   */
  announce(announcementData: bytes): void {
    assert(len(announcementData) >= 97);

    const count = this.announcementCount.value;
    this.announcements(count).value = announcementData;
    this.announcementCount.value = count + 1;

    log(concat(hex('616e6e6f756e6365'), itob(count)));
  }

  /**
   * Remove a meta-address registration. Reclaims box MBR.
   */
  deregister(label: bytes): void {
    assert(this.metaAddresses(label).exists);
    this.metaAddresses(label).delete();
  }
}

export default StealthRegistry;
