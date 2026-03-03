#!/usr/bin/env npx tsx
/**
 * Deploy PLONK LogicSig verifiers to Algorand testnet.
 *
 * 1. Compiles each circuit's PLONK verifier TEAL to get deterministic LogicSig addresses
 * 2. Calls setPlonkVerifiers() on each pool contract (creator-only method)
 *
 * Usage:
 *   npx tsx scripts/deploy-plonk-verifiers.ts
 *
 * Environment:
 *   DEPLOYER_MNEMONIC — must be the pool contract creator
 */

import algosdk from 'algosdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALGOD_URL = process.env.ALGOD_URL || 'https://testnet-api.algonode.cloud';
const ALGOD_TOKEN = process.env.ALGOD_TOKEN || '';

const CIRCUITS_DIR = path.resolve(__dirname, '../circuits/build');

// Pool contracts (all 3 denomination tiers)
const POOL_CONTRACTS = [
  { label: '0.1 ALGO', appId: 756420118 },
  { label: '0.5 ALGO', appId: 756420130 },
  { label: '1.0 ALGO', appId: 756420132 },
];

/** ARC-4 method selector */
function methodSelector(signature: string): Uint8Array {
  const hash = crypto.createHash('sha512-256').update(signature).digest();
  return new Uint8Array(hash.slice(0, 4));
}

async function main() {
  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL);

  if (!process.env.DEPLOYER_MNEMONIC) {
    console.error('DEPLOYER_MNEMONIC not set');
    process.exit(1);
  }

  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC);
  console.log(`Deployer: ${deployer.addr}`);

  // Step 1: Compile TEAL programs and get LogicSig addresses
  const circuits = ['withdraw', 'deposit', 'privateSend'];
  const addresses: Record<string, string> = {};

  for (const circuit of circuits) {
    const tealPath = path.join(CIRCUITS_DIR, `${circuit}_plonk_verifier.teal`);
    const tealSource = fs.readFileSync(tealPath, 'utf-8');

    const compiled = await algod.compile(Buffer.from(tealSource)).do();
    const program = new Uint8Array(Buffer.from(compiled.result, 'base64'));
    const lsig = new algosdk.LogicSigAccount(program);
    const addr = String(lsig.address());

    addresses[circuit] = addr;
    console.log(`\n${circuit} PLONK verifier:`);
    console.log(`  TEAL size:  ${tealSource.length} chars`);
    console.log(`  Compiled:   ${program.length} bytes`);
    console.log(`  Address:    ${addr}`);
  }

  // Step 2: Call setPlonkVerifiers on each pool contract
  // Method signature: setPlonkVerifiers(address,address,address)void
  const selector = methodSelector('setPlonkVerifiers(address,address,address)void');

  for (const pool of POOL_CONTRACTS) {
    console.log(`\nSetting PLONK verifiers on pool ${pool.label} (app ${pool.appId})...`);

    const params = await algod.getTransactionParams().do();

    // Encode addresses as 32-byte public keys for ABI
    const withdrawAddr = algosdk.decodeAddress(addresses.withdraw);
    const depositAddr = algosdk.decodeAddress(addresses.deposit);
    const privateSendAddr = algosdk.decodeAddress(addresses.privateSend);

    const appArgs = [
      selector,
      withdrawAddr.publicKey,
      depositAddr.publicKey,
      privateSendAddr.publicKey,
    ];

    const txn = algosdk.makeApplicationCallTxnFromObject({
      sender: deployer.addr,
      appIndex: pool.appId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs,
      suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
    });

    const signed = txn.signTxn(deployer.sk);
    const resp = await algod.sendRawTransaction(signed).do();
    const txId = (resp as any).txid ?? (resp as any).txId;
    const result = await algosdk.waitForConfirmation(algod, txId, 4);
    console.log(`  Confirmed in round ${(result as any).confirmedRound} (tx: ${txId})`);
  }

  // Step 3: Print config update
  console.log('\n\n=== UPDATE frontend/src/lib/config.ts ===');
  console.log(`PLONK_VERIFIER_ADDRESSES.testnet = {`);
  console.log(`  withdraw: '${addresses.withdraw}',`);
  console.log(`  deposit: '${addresses.deposit}',`);
  console.log(`  privateSend: '${addresses.privateSend}',`);
  console.log(`}`);

  // Also fund the LogicSig addresses (they need min balance for sending 0-value txns)
  console.log('\n\nFunding LogicSig addresses with min balance (0.1 ALGO each)...');
  for (const circuit of circuits) {
    const addr = addresses[circuit];
    const params = await algod.getTransactionParams().do();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: deployer.addr,
      receiver: addr,
      amount: 100_000, // 0.1 ALGO min balance
      suggestedParams: { ...params, fee: BigInt(1000), flatFee: true },
    });
    const signed = txn.signTxn(deployer.sk);
    const resp = await algod.sendRawTransaction(signed).do();
    const txId = (resp as any).txid ?? (resp as any).txId;
    await algosdk.waitForConfirmation(algod, txId, 4);
    console.log(`  Funded ${circuit}: ${addr} (0.1 ALGO)`);
  }

  console.log('\nDone! PLONK verifiers deployed and funded.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
