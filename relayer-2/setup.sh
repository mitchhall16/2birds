#!/bin/bash
# 2birds Relayer 2 — One-shot setup
# Run this on the second machine after cloning the repo
set -e

echo "=== 2birds Relayer 2 Setup ==="
echo ""

# 1. Generate a fresh Algorand wallet for this relayer
echo "Generating a new Algorand relayer wallet..."
node -e "
const algosdk = require('algosdk');
const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
console.log('ADDRESS: ' + account.addr);
console.log('MNEMONIC: ' + mnemonic);
console.log('');
console.log('⚠️  SAVE THIS MNEMONIC — you need it for wrangler secret put');
console.log('⚠️  FUND THIS ADDRESS with ~5 ALGO on testnet:');
console.log('    https://bank.testnet.algorand.network/?account=' + account.addr);
"

echo ""
echo "=== Next steps ==="
echo "1. Fund the address above with testnet ALGO"
echo "2. Run: npm install"
echo "3. Run: npx wrangler login"
echo "4. Run: npm run deploy"
echo "5. Run: npx wrangler secret put RELAYER_MNEMONIC"
echo "   (paste the mnemonic from above)"
echo "6. Run: npx wrangler secret put ALLOWED_ORIGINS"
echo "   (enter: https://2birds.pages.dev)"
echo "7. Send the worker URL and wallet address back to add to the frontend config"
