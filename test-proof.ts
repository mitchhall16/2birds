#!/usr/bin/env npx tsx

/**
 * Real ZK Proof Test — Generates and verifies an actual Groth16 proof
 *
 * This creates a deposit, builds a Merkle tree, generates a real
 * zero-knowledge proof, and verifies it. No blockchain needed.
 *
 * Run with: npx tsx test-proof.ts
 */

import { initMimc, mimcHash, mimcHashSingle, randomScalar } from './packages/core/src/index.js';
import * as snarkjs from 'snarkjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, 'circuits', 'build');

const DEPTH = 20;

function header(s: string) { console.log(`\n${'═'.repeat(60)}\n  ${s}\n${'═'.repeat(60)}\n`); }
function ok(s: string) { console.log(`  ✅ ${s}`); }
function info(s: string) { console.log(`  ℹ️  ${s}`); }

async function main() {
  header('Real ZK Proof — Withdrawal Circuit');

  // Step 0: Initialize MiMC (loads circomlibjs WASM, 220 rounds, exact circomlib match)
  info('Initializing MiMC sponge (circomlib-compatible, 220 rounds)...');
  await initMimc();

  // Step 1: Create a deposit
  info('Creating deposit (secret + nullifier)...');
  const secret = randomScalar();
  const nullifier = randomScalar();
  const commitment = mimcHash(secret, nullifier);
  const nullifierHash = mimcHashSingle(nullifier);
  ok(`Commitment: ${commitment.toString().slice(0, 20)}...`);
  ok(`NullifierHash: ${nullifierHash.toString().slice(0, 20)}...`);

  // Step 2: Build Merkle tree with this deposit as leaf 0
  info('Building Merkle tree (depth 20, 1 leaf)...');

  // Compute zero hashes: z[0] = 0, z[i] = MiMC(z[i-1], z[i-1])
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= DEPTH; i++) zeros[i] = mimcHash(zeros[i-1], zeros[i-1]);

  // Insert commitment at index 0 — at every level, sibling is the zero hash
  const pathElements: string[] = [];
  const pathIndices: number[] = [];
  let currentHash = commitment;

  for (let level = 0; level < DEPTH; level++) {
    pathElements.push(zeros[level].toString());
    pathIndices.push(0);
    currentHash = mimcHash(currentHash, zeros[level]);
  }

  const root = currentHash;
  ok(`Merkle root: ${root.toString().slice(0, 20)}...`);

  // Step 3: Set up public inputs
  const recipient = 12345678n;
  const relayer = 0n;
  const fee = 0n;

  // Step 4: Generate the proof
  info('Generating Groth16 proof (this takes 5-15 seconds)...');
  const startTime = Date.now();

  const input = {
    root: root.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: recipient.toString(),
    relayer: relayer.toString(),
    fee: fee.toString(),
    secret: secret.toString(),
    nullifier: nullifier.toString(),
    pathElements,
    pathIndices,
  };

  const wasmPath = path.join(BUILD, 'withdraw_js', 'withdraw.wasm');
  const zkeyPath = path.join(BUILD, 'withdraw_final.zkey');
  const vkeyPath = path.join(BUILD, 'withdraw_vkey.json');

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath,
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  ok(`Proof generated in ${elapsed}s`);
  ok(`Proof size: pi_a(2), pi_b(4), pi_c(2) = 8 field elements`);

  // Step 5: Verify the proof
  info('Verifying proof...');
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));

  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  ok(`Proof valid: ${valid}`);

  if (!valid) {
    console.error('  ❌ PROOF VERIFICATION FAILED');
    process.exit(1);
  }

  // Step 6: Show what would happen on-chain
  header('What happens on-chain');
  console.log(`
  The proof proves ALL of the following without revealing ANY private data:

  PUBLIC (visible on-chain):
    Root:          ${root.toString().slice(0, 16)}...
    NullifierHash: ${nullifierHash.toString().slice(0, 16)}...
    Recipient:     ${recipient}
    Relayer:       ${relayer}
    Fee:           ${fee}

  PRIVATE (hidden, known only to the prover):
    Secret:        [HIDDEN]
    Nullifier:     [HIDDEN]
    Which deposit: [HIDDEN] (Merkle path proves membership)

  ON-CHAIN VERIFICATION:
    1. LogicSig checks proof math (BN254 pairing check, ~145K opcodes)
    2. Contract checks nullifierHash not in nullifier set (box lookup)
    3. Contract checks root is a known historical root
    4. Contract sends ${fee === 0n ? 'full denomination' : `denomination - ${fee} fee`} to recipient
    5. Nullifier recorded — this deposit can never be withdrawn again

  Cost: ~0.008 ALGO (8 minimum transaction fees for LogicSig opcode budget)
  `);

  header('SUCCESS — Real ZK proof generated and verified!');
  console.log('  This is the exact same proof that would be verified on Algorand.');
  console.log('  The only difference is on-chain it runs inside a LogicSig');
  console.log('  instead of a local snarkjs verifier.\n');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
