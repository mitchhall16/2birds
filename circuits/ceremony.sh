#!/usr/bin/env bash
set -euo pipefail

# Multi-party Phase 2 Ceremony for Groth16 Circuits
#
# Phase 1 (powers of tau) is already multi-party (Hermez ceremony).
# This script manages the circuit-specific Phase 2 ceremony.
#
# Security model: as long as at least ONE contributor is honest and
# discards their toxic waste, the setup is secure.
#
# Usage:
#   ./ceremony.sh init <circuit>          Create initial zkey from r1cs + ptau
#   ./ceremony.sh contribute <circuit>    Add your contribution (interactive)
#   ./ceremony.sh verify <circuit>        Verify the full contribution chain
#   ./ceremony.sh beacon <circuit> <hex>  Apply random beacon to finalize
#   ./ceremony.sh finalize <circuit>      Export vkey from final zkey
#   ./ceremony.sh status <circuit>        Show contribution count and hashes
#
# Example full ceremony:
#   ./ceremony.sh init deposit
#   ./ceremony.sh contribute deposit      # Person 1
#   ./ceremony.sh contribute deposit      # Person 2 (on their machine)
#   ./ceremony.sh contribute deposit      # Person 3
#   ./ceremony.sh beacon deposit <bitcoin-block-hash>
#   ./ceremony.sh verify deposit
#   ./ceremony.sh finalize deposit

CIRCUIT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${CIRCUIT_DIR}/build"
CEREMONY_DIR="${BUILD_DIR}/ceremony"

command -v snarkjs >/dev/null 2>&1 || { echo "ERROR: snarkjs not found"; exit 1; }

get_ptau() {
    local circuit=$1
    local constraints
    constraints=$(snarkjs r1cs info "${BUILD_DIR}/${circuit}.r1cs" 2>&1 | grep "Constraints:" | awk '{print $NF}')
    if [ "$constraints" -gt 32768 ]; then
        echo "${BUILD_DIR}/powersOfTau28_hez_final_17.ptau"
    else
        echo "${BUILD_DIR}/powersOfTau28_hez_final_15.ptau"
    fi
}

# Count existing contribution files for a circuit
count_contributions() {
    local circuit=$1
    local dir="${CEREMONY_DIR}/${circuit}"
    if [ ! -d "$dir" ]; then echo 0; return; fi
    ls "${dir}"/${circuit}_*.zkey 2>/dev/null | wc -l | tr -d ' '
}

latest_zkey() {
    local circuit=$1
    local count
    count=$(count_contributions "$circuit")
    if [ "$count" -eq 0 ]; then
        echo ""
    else
        local idx=$((count - 1))
        printf "%s/%s/%s_%04d.zkey" "$CEREMONY_DIR" "$circuit" "$circuit" "$idx"
    fi
}

case "${1:-help}" in
    init)
        circuit="${2:?Usage: ceremony.sh init <circuit>}"
        r1cs="${BUILD_DIR}/${circuit}.r1cs"
        [ -f "$r1cs" ] || { echo "ERROR: ${r1cs} not found. Build the circuit first."; exit 1; }

        ptau=$(get_ptau "$circuit")
        [ -f "$ptau" ] || { echo "ERROR: ${ptau} not found."; exit 1; }

        mkdir -p "${CEREMONY_DIR}/${circuit}"
        outfile="${CEREMONY_DIR}/${circuit}/${circuit}_0000.zkey"

        echo "=== Initializing Phase 2 ceremony for: ${circuit} ==="
        echo "  R1CS: ${r1cs}"
        echo "  PTAU: ${ptau}"
        echo ""

        snarkjs groth16 setup "$r1cs" "$ptau" "$outfile"

        echo ""
        echo "Initial zkey created: ${outfile}"
        echo "Next: distribute this file and run './ceremony.sh contribute ${circuit}'"
        ;;

    contribute)
        circuit="${2:?Usage: ceremony.sh contribute <circuit>}"
        prev=$(latest_zkey "$circuit")
        [ -n "$prev" ] || { echo "ERROR: No zkey found. Run 'init' first."; exit 1; }

        count=$(count_contributions "$circuit")
        next_idx=$(printf "%04d" "$count")
        outfile="${CEREMONY_DIR}/${circuit}/${circuit}_${next_idx}.zkey"

        echo "=== Contributing to Phase 2 ceremony: ${circuit} ==="
        echo "  Input:  ${prev}"
        echo "  Output: ${outfile}"
        echo ""
        echo "You will be asked for random text. Type something unique and unpredictable."
        echo "Your entropy is mixed in and the intermediate state is discarded."
        echo ""

        # Read contributor name
        read -rp "Your name (for the contribution record): " name
        [ -n "$name" ] || name="anonymous-${next_idx}"

        snarkjs zkey contribute "$prev" "$outfile" --name="$name"

        echo ""
        echo "Contribution #${count} recorded: ${outfile}"
        echo "Contributor: ${name}"
        echo ""
        echo "IMPORTANT: Delete any temporary files and clear your terminal history."
        echo "Next: pass the zkey to the next contributor, or finalize with beacon."
        ;;

    verify)
        circuit="${2:?Usage: ceremony.sh verify <circuit>}"
        latest=$(latest_zkey "$circuit")
        [ -n "$latest" ] || { echo "ERROR: No zkey found."; exit 1; }

        r1cs="${BUILD_DIR}/${circuit}.r1cs"
        ptau=$(get_ptau "$circuit")

        echo "=== Verifying contribution chain for: ${circuit} ==="
        snarkjs zkey verify "$r1cs" "$ptau" "$latest"
        echo ""
        echo "Verification complete."
        ;;

    beacon)
        circuit="${2:?Usage: ceremony.sh beacon <circuit> <hex-entropy>}"
        beacon_hex="${3:?Provide beacon entropy as hex (e.g., a Bitcoin block hash)}"
        prev=$(latest_zkey "$circuit")
        [ -n "$prev" ] || { echo "ERROR: No zkey found."; exit 1; }

        count=$(count_contributions "$circuit")
        next_idx=$(printf "%04d" "$count")
        outfile="${CEREMONY_DIR}/${circuit}/${circuit}_${next_idx}.zkey"

        echo "=== Applying random beacon to: ${circuit} ==="
        echo "  Beacon: ${beacon_hex}"
        echo "  Iterations: 10 (2^10 hash iterations)"
        echo ""

        snarkjs zkey beacon "$prev" "$outfile" "$beacon_hex" 10 --name="beacon"

        echo ""
        echo "Beacon applied: ${outfile}"
        echo "This is the final zkey. Run 'verify' then 'finalize'."
        ;;

    finalize)
        circuit="${2:?Usage: ceremony.sh finalize <circuit>}"
        latest=$(latest_zkey "$circuit")
        [ -n "$latest" ] || { echo "ERROR: No zkey found."; exit 1; }

        final="${BUILD_DIR}/${circuit}_final.zkey"
        vkey="${BUILD_DIR}/${circuit}_vkey.json"

        echo "=== Finalizing ceremony for: ${circuit} ==="

        # Copy the final zkey
        cp "$latest" "$final"
        echo "  Final zkey: ${final}"

        # Export verification key
        snarkjs zkey export verificationkey "$final" "$vkey"
        echo "  Verification key: ${vkey}"

        echo ""
        echo "Ceremony complete. Update the TEAL verifier with the new vkey constants."
        echo "Copy outputs to frontend:"
        echo "  cp ${BUILD_DIR}/${circuit}_js/${circuit}.wasm frontend/public/circuits/"
        echo "  cp ${final} frontend/public/circuits/"
        echo "  cp ${vkey} frontend/public/circuits/"
        ;;

    status)
        circuit="${2:?Usage: ceremony.sh status <circuit>}"
        count=$(count_contributions "$circuit")
        echo "=== Ceremony status for: ${circuit} ==="
        echo "  Contributions: ${count}"

        if [ "$count" -gt 0 ]; then
            latest=$(latest_zkey "$circuit")
            echo "  Latest zkey: ${latest}"
            echo ""
            echo "Contribution hashes:"
            r1cs="${BUILD_DIR}/${circuit}.r1cs"
            ptau=$(get_ptau "$circuit")
            snarkjs zkey verify "$r1cs" "$ptau" "$latest" 2>&1 | grep -E "(Contribution|Hash|Name)" || true
        fi
        ;;

    help|*)
        echo "Usage: ceremony.sh <command> <circuit> [args]"
        echo ""
        echo "Commands:"
        echo "  init <circuit>              Create initial zkey"
        echo "  contribute <circuit>        Add a contribution (interactive)"
        echo "  verify <circuit>            Verify contribution chain"
        echo "  beacon <circuit> <hex>      Apply random beacon"
        echo "  finalize <circuit>          Export final zkey + vkey"
        echo "  status <circuit>            Show ceremony progress"
        echo ""
        echo "Circuits: withdraw, deposit, privateSend"
        echo ""
        echo "Example:"
        echo "  ./ceremony.sh init deposit"
        echo "  ./ceremony.sh contribute deposit"
        echo "  ./ceremony.sh beacon deposit 00000000000000000003a0c1..."
        echo "  ./ceremony.sh verify deposit"
        echo "  ./ceremony.sh finalize deposit"
        ;;
esac
