#!/usr/bin/env npx tsx
/**
 * Update deployed pool contracts with new approval program (adds setPlonkVerifiers).
 * Then calls setPlonkVerifiers to register PLONK LogicSig addresses.
 *
 * Usage:
 *   npx tsx scripts/update-pool-contracts.ts
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
const ARTIFACTS_DIR = path.resolve(__dirname, '../contracts/artifacts');
const CIRCUITS_DIR = path.resolve(__dirname, '../circuits/build');

const POOL_CONTRACTS = [
  { label: '0.1 ALGO', appId: 756420118 },
  { label: '0.5 ALGO', appId: 756420130 },
  { label: '1.0 ALGO', appId: 756420132 },
];

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

  // Step 1: Compile new approval/clear programs
  const approvalTeal = fs.readFileSync(path.join(ARTIFACTS_DIR, 'PrivacyPool.approval.teal'), 'utf-8');
  const clearTeal = fs.readFileSync(path.join(ARTIFACTS_DIR, 'PrivacyPool.clear.teal'), 'utf-8');

  const approvalCompiled = await algod.compile(Buffer.from(approvalTeal)).do();
  const clearCompiled = await algod.compile(Buffer.from(clearTeal)).do();

  const approvalBytes = new Uint8Array(Buffer.from(approvalCompiled.result, 'base64'));
  const clearBytes = new Uint8Array(Buffer.from(clearCompiled.result, 'base64'));

  console.log(`Approval program: ${approvalBytes.length} bytes`);
  console.log(`Clear program: ${clearBytes.length} bytes`);

  // Step 2: Compile PLONK verifier TEAL programs to get addresses
  const circuits = ['withdraw', 'deposit', 'privateSend'];
  const plonkAddresses: Record<string, string> = {};

  for (const circuit of circuits) {
    const tealPath = path.join(CIRCUITS_DIR, `${circuit}_plonk_verifier.teal`);
    const tealSource = fs.readFileSync(tealPath, 'utf-8');
    const compiled = await algod.compile(Buffer.from(tealSource)).do();
    const program = new Uint8Array(Buffer.from(compiled.result, 'base64'));
    const lsig = new algosdk.LogicSigAccount(program);
    plonkAddresses[circuit] = String(lsig.address());
    console.log(`${circuit} PLONK verifier: ${plonkAddresses[circuit]}`);
  }

  // Step 3: Update each pool contract
  for (const pool of POOL_CONTRACTS) {
    console.log(`\n--- Pool ${pool.label} (app ${pool.appId}) ---`);

    // Update the approval program
    console.log('Updating approval program...');
    const params = await algod.getTransactionParams().do();

    const updateSelector = methodSelector('updateApplication()void');
    const updateTxn = algosdk.makeApplicationUpdateTxnFromObject({
      sender: deployer.addr,
      appIndex: pool.appId,
      approvalProgram: approvalBytes,
      clearProgram: clearBytes,
      appArgs: [updateSelector],
      suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
    });

    const signedUpdate = updateTxn.signTxn(deployer.sk);
    const updateResp = await algod.sendRawTransaction(signedUpdate).do();
    const updateTxId = (updateResp as any).txid ?? (updateResp as any).txId;
    await algosdk.waitForConfirmation(algod, updateTxId, 4);
    console.log(`  Updated (tx: ${updateTxId})`);

    // Call setPlonkVerifiers
    console.log('Setting PLONK verifier addresses...');
    const params2 = await algod.getTransactionParams().do();

    const selector = methodSelector('setPlonkVerifiers(address,address,address)void');
    const withdrawAddr = algosdk.decodeAddress(plonkAddresses.withdraw);
    const depositAddr = algosdk.decodeAddress(plonkAddresses.deposit);
    const privateSendAddr = algosdk.decodeAddress(plonkAddresses.privateSend);

    const setTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: deployer.addr,
      appIndex: pool.appId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [selector, withdrawAddr.publicKey, depositAddr.publicKey, privateSendAddr.publicKey],
      suggestedParams: { ...params2, fee: BigInt(2000), flatFee: true },
    });

    const signedSet = setTxn.signTxn(deployer.sk);
    const setResp = await algod.sendRawTransaction(signedSet).do();
    const setTxId = (setResp as any).txid ?? (setResp as any).txId;
    await algosdk.waitForConfirmation(algod, setTxId, 4);
    console.log(`  PLONK verifiers set (tx: ${setTxId})`);
  }

  // Step 4: Fund LogicSig addresses
  console.log('\nFunding LogicSig addresses...');
  for (const circuit of circuits) {
    const addr = plonkAddresses[circuit];
    // Check if already funded
    try {
      const info = await algod.accountInformation(addr).do();
      if (Number(info.amount) >= 100_000) {
        console.log(`  ${circuit}: already funded (${Number(info.amount) / 1e6} ALGO)`);
        continue;
      }
    } catch {}

    const params = await algod.getTransactionParams().do();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: deployer.addr,
      receiver: addr,
      amount: 100_000,
      suggestedParams: { ...params, fee: BigInt(1000), flatFee: true },
    });
    const signed = txn.signTxn(deployer.sk);
    const resp = await algod.sendRawTransaction(signed).do();
    const txId = (resp as any).txid ?? (resp as any).txId;
    await algosdk.waitForConfirmation(algod, txId, 4);
    console.log(`  ${circuit}: funded 0.1 ALGO (tx: ${txId})`);
  }

  // Step 5: Print config update
  console.log('\n=== Config Update for frontend/src/lib/config.ts ===');
  console.log(`testnet: {`);
  console.log(`  withdraw: '${plonkAddresses.withdraw}',`);
  console.log(`  deposit: '${plonkAddresses.deposit}',`);
  console.log(`  privateSend: '${plonkAddresses.privateSend}',`);
  console.log(`}`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
