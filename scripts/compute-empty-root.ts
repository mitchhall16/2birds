#!/usr/bin/env npx tsx
/**
 * Compute the MiMC empty tree root for a depth-16 Merkle tree.
 *
 * The empty tree has all zero leaves. The root is computed by recursively hashing:
 *   zeros[0] = 0
 *   zeros[i] = MiMCSponge(zeros[i-1], zeros[i-1], k=0)
 *
 * Output: hex string suitable for hardcoding in the contract.
 */

import { buildMimcSponge } from 'circomlibjs'

async function main() {
  const mimcSponge = await buildMimcSponge()
  const F = mimcSponge.F

  const DEPTH = 16
  const zeros: bigint[] = [0n]

  for (let i = 1; i <= DEPTH; i++) {
    const hash = mimcSponge.multiHash([zeros[i - 1], zeros[i - 1]], 0, 1)
    zeros[i] = F.toObject(hash)
  }

  const emptyRoot = zeros[DEPTH]

  // Convert to 32-byte big-endian hex
  const hex = emptyRoot.toString(16).padStart(64, '0')

  console.log(`Empty tree root (depth ${DEPTH}):`)
  console.log(`  Decimal: ${emptyRoot}`)
  console.log(`  Hex:     ${hex}`)
  console.log(`  TealScript: hex('${hex}')`)

  // Also output all zero hashes for reference
  console.log('\nAll zero hashes:')
  for (let i = 0; i <= DEPTH; i++) {
    console.log(`  Level ${i.toString().padStart(2)}: ${zeros[i].toString(16).padStart(64, '0')}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
