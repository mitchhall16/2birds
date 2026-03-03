#!/usr/bin/env npx tsx
import algosdk from 'algosdk';
import 'dotenv/config';

async function main() {
  const algod = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud');
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);

  const toFund = [
    // Pool app addresses (need ALGO for box storage)
    { label: 'Pool 0.5', addr: 'E5TRMAZSX6FCSFVZU6OLS372YB56GAW662CHX2NAD6C7VATSYYVXECKDG4', amount: 1_000_000 },
    { label: 'Pool 1.0', addr: '624W56BLCEIXUMOYCDYACW3QOJEKQTCC6YXY4Q7Z3Z4WQUOBERZTUEHP7I', amount: 1_000_000 },
    // PLONK LogicSig addresses (need min balance for 0-value txns)
    { label: 'PLONK withdraw', addr: 'Y5EGJIAMTCQJ5VYEPPNHUXLJ2QOAQRFION77ILEOFM63V5DOURIOSLE2XE', amount: 100_000 },
    { label: 'PLONK deposit', addr: 'T7LRWUZ3PL5RPGNMFDQNU7KETGLG2KKXV2YWODJ4KZFJSN5I3IPQEH7E44', amount: 100_000 },
    { label: 'PLONK privateSend', addr: 'ANQG655MULTMHGQVJEEBKUDISGQ7OFNG7WBQXQPHQOKH4LSO5QMNA2KLIE', amount: 100_000 },
  ];

  for (const { label, addr, amount } of toFund) {
    try {
      const info = await algod.accountInformation(addr).do();
      if (Number(info.amount) >= amount) {
        console.log(`${label}: already funded (${Number(info.amount) / 1e6} ALGO)`);
        continue;
      }
    } catch {}

    const params = await algod.getTransactionParams().do();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: deployer.addr,
      receiver: addr,
      amount,
      suggestedParams: { ...params, fee: BigInt(1000), flatFee: true },
    });
    const signed = txn.signTxn(deployer.sk);
    const resp = await algod.sendRawTransaction(signed).do();
    const txId = (resp as any).txid ?? (resp as any).txId;
    await algosdk.waitForConfirmation(algod, txId, 4);
    console.log(`${label}: funded ${amount / 1e6} ALGO (tx: ${txId})`);
  }

  const info = await algod.accountInformation(deployer.addr).do();
  console.log(`\nDeployer remaining: ${Number(info.amount) / 1e6} ALGO`);
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
