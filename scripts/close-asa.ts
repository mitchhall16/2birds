#!/usr/bin/env npx tsx
/**
 * Close out an ASA to free up min balance.
 */
import algosdk from 'algosdk';
import 'dotenv/config';

async function main() {
  const algod = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud');
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);

  const params = await algod.getTransactionParams().do();

  // Close out ASA 10458941 — send all to self with closeTo=self to opt out
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr,
    receiver: deployer.addr,
    amount: 0,
    assetIndex: 10458941,
    closeRemainderTo: deployer.addr, // Close the entire position back to self (which then opts out)
    suggestedParams: { ...params, fee: BigInt(1000), flatFee: true },
  });

  // Close to the asset creator to opt out
  // First find the asset creator
  const assetInfo = await algod.getAssetByID(10458941).do();
  const creator = String((assetInfo as any).params.creator);
  console.log(`Closing ASA to creator: ${creator}`);

  const closeTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr,
    receiver: creator,
    amount: 0,
    assetIndex: 10458941,
    closeRemainderTo: creator,
    suggestedParams: { ...params, fee: BigInt(1000), flatFee: true },
  });

  const signed = closeTxn.signTxn(deployer.sk);
  const resp = await algod.sendRawTransaction(signed).do();
  const txId = (resp as any).txid ?? (resp as any).txId;
  await algosdk.waitForConfirmation(algod, txId, 4);
  console.log(`Closed ASA 10458941, tx: ${txId}`);

  const info = await algod.accountInformation(deployer.addr).do();
  console.log(`New balance: ${Number(info.amount) / 1e6} ALGO`);
  console.log(`New min: ${Number(info.minBalance) / 1e6} ALGO`);
  console.log(`Available: ${(Number(info.amount) - Number(info.minBalance)) / 1e6} ALGO`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
