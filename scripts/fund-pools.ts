import algosdk from 'algosdk';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '');
const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);

const pools = [
  'DOIY26VVBDURORVRC52UHGXUFCZ2FB725T3YNDJJOIM2BQTQFDGO75XBTQ',
  'W2IBUIN32FL7JIHTDVDFDVG6F4HHWP4X2CJRDVFBKC6Y7MVJ22INRVGEIY',
  'O3I26T6EZ2UCCSWHQGMD6R5XJUX2AK3DU5I7S76M2SA2AE63IFZFUMPKEU',
];

async function main() {
  const params = await client.getTransactionParams().do();
  for (const addr of pools) {
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: deployer.addr.toString(),
      receiver: addr,
      amount: 200_000,
      suggestedParams: params,
    });
    const signed = txn.signTxn(deployer.sk);
    await client.sendRawTransaction(signed).do();
    console.log('Funded', addr.slice(0, 8), 'with 0.2 ALGO');
  }
}
main();
