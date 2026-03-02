#!/usr/bin/env npx tsx
/**
 * Deploy all privacy-sdk v2 contracts to Algorand testnet:
 *   1. Budget helper app (for opcode budget padding)
 *   2. ZK verifier app (Groth16, 6 public signals)
 *   3. Three PrivacyPool instances (0.1, 0.5, 1.0 ALGO denominations)
 *
 * Usage:
 *   npx tsx scripts/deploy-all.ts
 *
 * Requires DEPLOYER_MNEMONIC in .env or environment
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

/** Compute ARC-4 method selector: first 4 bytes of SHA-512/256(signature) */
function methodSelector(signature: string): Uint8Array {
  const hash = crypto.createHash('sha512-256').update(signature).digest();
  return new Uint8Array(hash.slice(0, 4));
}

/** ABI-encode a uint64 as 8 bytes big-endian */
function abiUint64(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(n));
  return buf;
}

async function deployApp(
  algod: algosdk.Algodv2,
  deployer: algosdk.Account,
  approvalTeal: string,
  clearTeal: string,
  label: string,
  opts?: {
    globalInts?: number;
    globalBytes?: number;
    appArgs?: Uint8Array[];
    boxes?: { appIndex: number; name: Uint8Array }[];
  },
): Promise<{ appId: number; appAddress: string; txId: string }> {
  const approvalCompiled = await algod.compile(Buffer.from(approvalTeal)).do();
  const approvalBytes = new Uint8Array(Buffer.from(approvalCompiled.result, 'base64'));
  console.log(`  ${label} approval: ${approvalBytes.length} bytes`);

  const clearCompiled = await algod.compile(Buffer.from(clearTeal)).do();
  const clearBytes = new Uint8Array(Buffer.from(clearCompiled.result, 'base64'));

  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makeApplicationCreateTxnFromObject({
    sender: deployer.addr,
    approvalProgram: approvalBytes,
    clearProgram: clearBytes,
    numGlobalInts: opts?.globalInts ?? 0,
    numGlobalByteSlices: opts?.globalBytes ?? 0,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: opts?.appArgs,
    boxes: opts?.boxes,
    suggestedParams: { ...params, fee: BigInt(2000), flatFee: true },
  });

  const signed = txn.signTxn(deployer.sk);
  const resp = await algod.sendRawTransaction(signed).do();
  const txId = (resp as any).txid ?? (resp as any).txId;

  const result = await algosdk.waitForConfirmation(algod, txId, 4);
  const appId = Number((result as any).applicationIndex);
  const appAddress = String(algosdk.getApplicationAddress(appId));

  return { appId, appAddress, txId };
}

async function main() {
  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL);

  if (!process.env.DEPLOYER_MNEMONIC) {
    console.error('Set DEPLOYER_MNEMONIC in .env or environment');
    process.exit(1);
  }

  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC);
  console.log(`Deployer: ${deployer.addr}`);

  const accountInfo = await algod.accountInformation(deployer.addr).do();
  const balance = accountInfo.amount;
  console.log(`Balance: ${(Number(balance) / 1_000_000).toFixed(6)} ALGO\n`);

  if (balance < 5_000_000n) {
    console.error('Need at least 5 ALGO for deploying all contracts.');
    console.log(`Fund at: https://bank.testnet.algorand.network/?account=${deployer.addr}`);
    process.exit(1);
  }

  // Read TEAL sources
  const helperTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/budget_helper.teal'), 'utf-8',
  );
  const verifierTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/withdraw_verifier.teal'), 'utf-8',
  );
  const depositVerifierTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/deposit_verifier.teal'), 'utf-8',
  );
  const clearTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/withdraw_verifier_clear.teal'), 'utf-8',
  );
  const depositVerifierClearTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/deposit_verifier_clear.teal'), 'utf-8',
  );
  const privateSendVerifierTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/privateSend_verifier.teal'), 'utf-8',
  );
  const privateSendVerifierClearTeal = fs.readFileSync(
    path.resolve(__dirname, '../contracts/privateSend_verifier_clear.teal'), 'utf-8',
  );
  const poolApprovalTeal = fs.readFileSync(
    path.join(ARTIFACTS_DIR, 'PrivacyPool.approval.teal'), 'utf-8',
  );
  const poolClearTeal = fs.readFileSync(
    path.join(ARTIFACTS_DIR, 'PrivacyPool.clear.teal'), 'utf-8',
  );

  // Read ARC-56 for schema info
  const arc56 = JSON.parse(fs.readFileSync(
    path.join(ARTIFACTS_DIR, 'PrivacyPool.arc56.json'), 'utf-8',
  ));
  const poolGlobalInts = arc56.state?.schema?.global?.ints ?? 4;
  const poolGlobalBytes = arc56.state?.schema?.global?.bytes ?? 4;

  // ── 1. Deploy budget helper ──
  console.log('1. Deploying budget helper...');
  const helper = await deployApp(algod, deployer, helperTeal, clearTeal, 'Budget helper');
  console.log(`   App ID: ${helper.appId}`);
  console.log(`   Tx: ${helper.txId}\n`);

  // ── 2. Deploy ZK withdraw verifier ──
  console.log('2. Deploying ZK withdraw verifier (6 public signals)...');
  const verifier = await deployApp(algod, deployer, verifierTeal, clearTeal, 'ZK withdraw verifier');
  console.log(`   App ID: ${verifier.appId}`);
  console.log(`   Address: ${verifier.appAddress}`);
  console.log(`   Tx: ${verifier.txId}\n`);

  // ── 2b. Deploy ZK deposit (insertion) verifier ──
  console.log('2b. Deploying ZK deposit verifier (4 public signals)...');
  const depositVerifier = await deployApp(algod, deployer, depositVerifierTeal, depositVerifierClearTeal, 'ZK deposit verifier');
  console.log(`   App ID: ${depositVerifier.appId}`);
  console.log(`   Address: ${depositVerifier.appAddress}`);
  console.log(`   Tx: ${depositVerifier.txId}\n`);

  // ── 2c. Deploy ZK privateSend verifier ──
  console.log('2c. Deploying ZK privateSend verifier (9 public signals)...');
  const privateSendVerifier = await deployApp(algod, deployer, privateSendVerifierTeal, privateSendVerifierClearTeal, 'ZK privateSend verifier');
  console.log(`   App ID: ${privateSendVerifier.appId}`);
  console.log(`   Address: ${privateSendVerifier.appAddress}`);
  console.log(`   Tx: ${privateSendVerifier.txId}\n`);

  // ── 3. Deploy 3 pool instances ──
  const tiers = [
    { label: '0.1 ALGO', microAlgos: 100_000 },
    { label: '0.5 ALGO', microAlgos: 500_000 },
    { label: '1.0 ALGO', microAlgos: 1_000_000 },
  ];

  const pools: Record<string, { appId: number; appAddress: string; txId: string }> = {};

  for (const tier of tiers) {
    console.log(`3. Deploying PrivacyPool (${tier.label} denomination)...`);
    const pool = await deployApp(
      algod, deployer, poolApprovalTeal, poolClearTeal,
      `Pool ${tier.label}`,
      {
        globalInts: poolGlobalInts,
        globalBytes: poolGlobalBytes,
        appArgs: [
          methodSelector('createApplication(uint64,uint64,uint64,uint64,uint64)void'),
          abiUint64(tier.microAlgos),
          abiUint64(0), // ALGO (not ASA)
          abiUint64(verifier.appId), // ZK withdraw verifier app ID
          abiUint64(depositVerifier.appId), // ZK deposit verifier app ID
          abiUint64(privateSendVerifier.appId), // ZK privateSend verifier app ID
        ],
      },
    );
    pools[tier.microAlgos.toString()] = pool;
    console.log(`   App ID: ${pool.appId}`);
    console.log(`   Address: ${pool.appAddress}`);
    console.log(`   Tx: ${pool.txId}\n`);
  }

  // ── 4. Update deployment-testnet.json ──
  const deployPath = path.resolve(__dirname, '../deployment-testnet.json');
  const deployment = JSON.parse(fs.readFileSync(deployPath, 'utf-8'));

  deployment.timestamp = new Date().toISOString();
  deployment.contracts.BudgetHelper = {
    appId: helper.appId,
    appAddress: helper.appAddress,
    txId: helper.txId,
  };
  deployment.contracts.ZkVerifier = {
    appId: verifier.appId,
    appAddress: verifier.appAddress,
    txId: verifier.txId,
    budgetHelperAppId: helper.appId,
  };
  deployment.contracts.DepositVerifier = {
    appId: depositVerifier.appId,
    appAddress: depositVerifier.appAddress,
    txId: depositVerifier.txId,
    budgetHelperAppId: helper.appId,
  };
  deployment.contracts.PrivateSendVerifier = {
    appId: privateSendVerifier.appId,
    appAddress: privateSendVerifier.appAddress,
    txId: privateSendVerifier.txId,
    budgetHelperAppId: helper.appId,
  };
  deployment.contracts.PrivacyPool_100000 = {
    appId: pools['100000'].appId,
    appAddress: pools['100000'].appAddress,
    txId: pools['100000'].txId,
    denomination: 100_000,
  };
  deployment.contracts.PrivacyPool_500000 = {
    appId: pools['500000'].appId,
    appAddress: pools['500000'].appAddress,
    txId: pools['500000'].txId,
    denomination: 500_000,
  };
  deployment.contracts.PrivacyPool_1000000 = {
    appId: pools['1000000'].appId,
    appAddress: pools['1000000'].appAddress,
    txId: pools['1000000'].txId,
    denomination: 1_000_000,
  };
  fs.writeFileSync(deployPath, JSON.stringify(deployment, null, 2));
  console.log('Updated deployment-testnet.json');

  // ── 5. Update frontend config ──
  const configPath = path.resolve(__dirname, '../frontend/src/lib/config.ts');
  let config = fs.readFileSync(configPath, 'utf-8');

  // Update ZkVerifier
  config = config.replace(
    /ZkVerifier: \{[^}]+\}/,
    `ZkVerifier: {\n    appId: ${verifier.appId},\n    budgetHelperAppId: ${helper.appId},\n  }`,
  );

  // Update DepositVerifier
  config = config.replace(
    /DepositVerifier: \{[^}]+\}/,
    `DepositVerifier: {\n    appId: ${depositVerifier.appId},\n    budgetHelperAppId: ${helper.appId},\n  }`,
  );

  // Update PrivateSendVerifier
  config = config.replace(
    /PrivateSendVerifier: \{[^}]+\}/,
    `PrivateSendVerifier: {\n    appId: ${privateSendVerifier.appId},\n    budgetHelperAppId: ${helper.appId},\n  }`,
  );

  // Update POOL_CONTRACTS
  config = config.replace(
    /export const POOL_CONTRACTS:[\s\S]*?\n\}/,
    `export const POOL_CONTRACTS: Record<string, { appId: number; appAddress: string }> = {
  '100000': { appId: ${pools['100000'].appId}, appAddress: '${pools['100000'].appAddress}' },
  '500000': { appId: ${pools['500000'].appId}, appAddress: '${pools['500000'].appAddress}' },
  '1000000': { appId: ${pools['1000000'].appId}, appAddress: '${pools['1000000'].appAddress}' },
}`,
  );

  // Update DEFAULT_POOL (use 1.0 ALGO pool as default)
  config = config.replace(
    /const DEFAULT_POOL_APP_ID = \d+/,
    `const DEFAULT_POOL_APP_ID = ${pools['1000000'].appId}`,
  );
  config = config.replace(
    /const DEFAULT_POOL_APP_ADDRESS = '[^']+'/,
    `const DEFAULT_POOL_APP_ADDRESS = '${pools['1000000'].appAddress}'`,
  );

  fs.writeFileSync(configPath, config);
  console.log('Updated frontend/src/lib/config.ts\n');

  // ── Summary ──
  console.log('=== Deployment Complete ===');
  console.log(`Budget Helper:         ${helper.appId}`);
  console.log(`ZK Verifier:           ${verifier.appId}`);
  console.log(`Deposit Verifier:      ${depositVerifier.appId}`);
  console.log(`PrivateSend Verifier:  ${privateSendVerifier.appId}`);
  console.log(`Pool (0.1):            ${pools['100000'].appId}`);
  console.log(`Pool (0.5):            ${pools['500000'].appId}`);
  console.log(`Pool (1.0):            ${pools['1000000'].appId}`);
}

main().catch(err => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
