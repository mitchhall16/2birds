#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════
#  Two-Machine Phase 2 Ceremony
#
#  Machine 1 (this machine):
#    ./run-ceremony.sh step1         Init + contribute for all circuits
#    → Copy circuits/build/ceremony/ folder to Machine 2
#
#  Machine 2 (other computer):
#    ./run-ceremony.sh step2         Add second contribution
#    → Copy circuits/build/ceremony/ folder back to Machine 1
#
#  Machine 1 (back here):
#    ./run-ceremony.sh step3         Beacon + verify + finalize + deploy
#
# ═══════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CEREMONY="${SCRIPT_DIR}/ceremony.sh"
BUILD_DIR="${SCRIPT_DIR}/build"
FRONTEND_DIR="${SCRIPT_DIR}/../frontend/public/circuits"

CIRCUITS=(withdraw deposit privateSend)

case "${1:-help}" in
  step1)
    echo "═══════════════════════════════════════════════════════"
    echo "  STEP 1: Initialize + First Contribution (Machine 1)"
    echo "═══════════════════════════════════════════════════════"
    echo ""

    # Make sure circuits are compiled
    for c in "${CIRCUITS[@]}"; do
      if [ ! -f "${BUILD_DIR}/${c}.r1cs" ]; then
        echo "ERROR: ${c}.r1cs not found. Run './build.sh all' first."
        exit 1
      fi
    done

    for c in "${CIRCUITS[@]}"; do
      echo ""
      echo "──── Circuit: ${c} ────"
      "${CEREMONY}" init "$c"
      "${CEREMONY}" contribute "$c"
    done

    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  STEP 1 COMPLETE"
    echo ""
    echo "  Now copy the ceremony folder to your other computer:"
    echo ""
    echo "    scp -r circuits/build/ceremony/ user@other-machine:~/ceremony-transfer/"
    echo ""
    echo "  Also copy these files (needed for step2):"
    echo "    scp circuits/run-ceremony.sh user@other-machine:~/"
    echo "    scp circuits/ceremony.sh user@other-machine:~/"
    echo ""
    echo "  On the other machine, run:"
    echo "    ./run-ceremony.sh step2"
    echo "═══════════════════════════════════════════════════════"
    ;;

  step2)
    echo "═══════════════════════════════════════════════════════"
    echo "  STEP 2: Second Contribution (Machine 2)"
    echo "═══════════════════════════════════════════════════════"
    echo ""

    for c in "${CIRCUITS[@]}"; do
      echo ""
      echo "──── Circuit: ${c} ────"
      "${CEREMONY}" contribute "$c"
    done

    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  STEP 2 COMPLETE"
    echo ""
    echo "  Now copy the ceremony folder back to Machine 1:"
    echo ""
    echo "    scp -r circuits/build/ceremony/ user@machine-1:~/privacy-sdk/circuits/build/"
    echo ""
    echo "  On Machine 1, run:"
    echo "    ./run-ceremony.sh step3"
    echo ""
    echo "  DELETE the ceremony folder from this machine now:"
    echo "    rm -rf circuits/build/ceremony/"
    echo "═══════════════════════════════════════════════════════"
    ;;

  step3)
    echo "═══════════════════════════════════════════════════════"
    echo "  STEP 3: Beacon + Verify + Finalize (Machine 1)"
    echo "═══════════════════════════════════════════════════════"
    echo ""

    # Use a recent Bitcoin block hash as beacon entropy (public randomness)
    echo "Fetching latest Bitcoin block hash for beacon entropy..."
    BEACON_HEX=$(curl -sf "https://blockchain.info/q/latesthash" || echo "")
    if [ -z "$BEACON_HEX" ]; then
      echo "Could not fetch Bitcoin block hash. Enter beacon entropy manually:"
      read -rp "Hex entropy (e.g. a block hash): " BEACON_HEX
    fi
    echo "  Beacon: ${BEACON_HEX}"
    echo ""

    for c in "${CIRCUITS[@]}"; do
      echo ""
      echo "──── Circuit: ${c} ────"

      # Verify contribution chain
      "${CEREMONY}" verify "$c"

      # Apply random beacon (third contribution, non-interactive)
      "${CEREMONY}" beacon "$c" "$BEACON_HEX"

      # Finalize — export final zkey + vkey
      "${CEREMONY}" finalize "$c"
    done

    # Copy outputs to frontend
    echo ""
    echo "──── Copying outputs to frontend ────"
    mkdir -p "${FRONTEND_DIR}"
    for c in "${CIRCUITS[@]}"; do
      cp "${BUILD_DIR}/${c}_js/${c}.wasm" "${FRONTEND_DIR}/"
      cp "${BUILD_DIR}/${c}_final.zkey" "${FRONTEND_DIR}/"
      cp "${BUILD_DIR}/${c}_vkey.json" "${FRONTEND_DIR}/"
      echo "  Copied ${c} → frontend/public/circuits/"
    done

    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  CEREMONY COMPLETE"
    echo ""
    echo "  2 human contributions + 1 beacon applied to each circuit."
    echo ""
    echo "  Next steps:"
    echo "    1. Regenerate TEAL verifiers from the new vkeys:"
    echo "       npx tsx contracts/generate-verifier.ts"
    echo "    2. Redeploy verifier apps:"
    echo "       npx tsx scripts/deploy-all.ts"
    echo "    3. Update frontend config with new app IDs"
    echo ""
    echo "  DELETE the ceremony intermediate files:"
    echo "    rm -rf circuits/build/ceremony/"
    echo "═══════════════════════════════════════════════════════"
    ;;

  status)
    for c in "${CIRCUITS[@]}"; do
      "${CEREMONY}" status "$c"
      echo ""
    done
    ;;

  help|*)
    echo "Two-Machine Phase 2 Ceremony"
    echo ""
    echo "Usage:"
    echo "  ./run-ceremony.sh step1    Machine 1: init + first contribution"
    echo "  ./run-ceremony.sh step2    Machine 2: second contribution"
    echo "  ./run-ceremony.sh step3    Machine 1: beacon + verify + finalize"
    echo "  ./run-ceremony.sh status   Show ceremony progress for all circuits"
    echo ""
    echo "Circuits: ${CIRCUITS[*]}"
    ;;
esac
