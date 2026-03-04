#!/usr/bin/env npx tsx
import algosdk from 'algosdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALGOD_URL = process.env.ALGOD_URL || 'https://testnet-api.algonode.cloud';
const ARTIFACTS_DIR = path.resolve(__dirname, '../contracts/artifacts');
const CIRCUITS_DIR = path.resolve(__dirname, '../circuits/build');

function methodSelector(sig: string): Uint8Array {
  return new Uint8Array(crypto.createHash('sha512-256').update(sig).digest().slice(0, 4));
}
function abiUint64(n: number): Uint8Array {
  const buf = new Uint8Array(8); new DataView(buf.buffer).setBigUint64(0, BigInt(n)); return buf;
}

async function main() {
  const algod = new algosdk.Algodv2('', ALGOD_URL);
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);
  console.log(`Deployer: ${deployer.addr}`);

  const info = await algod.accountInformation(deployer.addr).do();
  console.log(`Available: ${((Number(info.amount) - Number(info.minBalance)) / 1e6).toFixed(4)} ALGO`);

  const approvalTeal = fs.readFileSync(path.join(ARTIFACTS_DIR, 'PrivacyPool.approval.teal'), 'utf-8');
  const clearTeal = fs.readFileSync(path.join(ARTIFACTS_DIR, 'PrivacyPool.clear.teal'), 'utf-8');
  const approvalCompiled = await algod.compile(Buffer.from(approvalTeal)).do();
  const clearCompiled = await algod.compile(Buffer.from(clearTeal)).do();
  const approvalBytes = new Uint8Array(Buffer.from(approvalCompiled.result, 'base64'));
  const clearBytes = new Uint8Array(Buffer.from(clearCompiled.result, 'base64'));

  const arc56 = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, 'PrivacyPool.arc56.json'), 'utf-8'));
  const globalInts = arc56.state?.schema?.global?.ints ?? 8;
  const globalBytes = arc56.state?.schema?.global?.bytes ?? 8;
  console.log(`Schema: ${globalInts} ints, ${globalBytes} bytes`);
  console.log(`MBR cost: ${(100000 + globalInts * 28500 + globalBytes * 50000) / 1e6} ALGO`);

  // Create pool
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makeApplicationCreateTxnFromObject({
    sender: deployer.addr,
    approvalProgram: approvalBytes,
    clearProgram: clearBytes,
    numGlobalInts: globalInts,
    numGlobalByteSlices: globalBytes,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [
      methodSelector('createApplication(uint64,uint64,uint64,uint64,uint64)void'),
      abiUint64(1_000_000), abiUint64(0),
      abiUint64(756420114), abiUint64(756420115), abiUint64(756420116),
    ],
    suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
  });

  const signed = txn.signTxn(deployer.sk);
  const resp = await algod.sendRawTransaction(signed).do();
  const txId = (resp as any).txid ?? (resp as any).txId;
  const result = await algosdk.waitForConfirmation(algod, txId, 4);
  const appId = Number((result as any).applicationIndex);
  const appAddr = String(algosdk.getApplicationAddress(appId));
  console.log(`\nPool 1.0 ALGO: appId=${appId}, address=${appAddr}`);

  // Check remaining balance
  const info2 = await algod.accountInformation(deployer.addr).do();
  const avail = (Number(info2.amount) - Number(info2.minBalance)) / 1e6;
  console.log(`Remaining available: ${avail.toFixed(4)} ALGO`);

  // Set PLONK verifiers
  const plonkAddrs: Record<string, string> = {};
  for (const c of ['withdraw', 'deposit', 'privateSend']) {
    const compiled = await algod.compile(Buffer.from(fs.readFileSync(path.join(CIRCUITS_DIR, `${c}_plonk_verifier.teal`), 'utf-8'))).do();
    const prog = new Uint8Array(Buffer.from(compiled.result, 'base64'));
    plonkAddrs[c] = String(new algosdk.LogicSigAccount(prog).address());
  }

  const params2 = await algod.getTransactionParams().do();
  const setTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: deployer.addr,
    appIndex: appId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [
      methodSelector('setPlonkVerifiers(address,address,address)void'),
      algosdk.decodeAddress(plonkAddrs.withdraw).publicKey,
      algosdk.decodeAddress(plonkAddrs.deposit).publicKey,
      algosdk.decodeAddress(plonkAddrs.privateSend).publicKey,
    ],
    suggestedParams: { ...params2, fee: BigInt(2000), flatFee: true },
  });
  const signedSet = setTxn.signTxn(deployer.sk);
  const setResp = await algod.sendRawTransaction(signedSet).do();
  const setTxId = (setResp as any).txid ?? (setResp as any).txId;
  await algosdk.waitForConfirmation(algod, setTxId, 4);
  console.log('PLONK verifiers set');

  console.log(`\n=== Config ===`);
  console.log(`'1000000': { appId: ${appId}, appAddress: '${appAddr}' }`);
}

main().catch(e => { console.error('Failed:', e.message || e); process.exit(1); });
