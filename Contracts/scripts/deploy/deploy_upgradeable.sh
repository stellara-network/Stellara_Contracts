#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# deploy_upgradeable.sh
#
# Deployment script for Stellara upgradeable contracts with built-in
# initializer protection verification.
#
# This script:
#   1. Builds all contract WASM binaries
#   2. Runs upgradeability unit tests and upgrade-path integration tests
#   3. Runs the EVM treasury governance suite (batch atomicity, pause gates,
#      emergency withdrawals) — a governance regression there is as
#      deployment-blocking as a failing initializer guard
#   4. Deploys contracts to the target network
#   5. Calls initialize() once on each contract
#   6. Verifies that a second initialize() call is rejected
#
# Usage:
#   ./scripts/deploy/deploy_upgradeable.sh [--network testnet|mainnet]
#
# Environment:
#   SKIP_TREASURY_TESTS=1  Skip step 5 (the Hardhat treasury suite). Intended
#                          only for environments without a Node toolchain; the
#                          suite is otherwise required before deploying.
#
# Prerequisites:
#   - Stellar CLI installed (stellar --version)
#   - Rust toolchain with wasm32-unknown-unknown target
#   - Node.js toolchain for the Hardhat treasury suite (npm install)
#   - Funded account configured as 'deployer'
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

NETWORK="${1:---network}"
NETWORK_NAME="${2:-testnet}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()    { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC}     $1"; }

# ── Step 1: Build WASM binaries ──────────────────────────────────────
info "Building contract WASM binaries..."
cargo build --release --target wasm32-unknown-unknown
success "WASM binaries built successfully"

# ── Step 2: Run upgradeability unit tests ────────────────────────────
info "Running upgradeability module tests..."
cargo test -p upgradeability -- --test-threads=1
success "Upgradeability unit tests passed"

# ── Step 3: Run upgrade-path integration tests ───────────────────────
info "Running upgrade-path integration tests..."
cargo test -p integration-tests --test upgrade_paths -- --test-threads=1
success "Upgrade-path integration tests passed"

# ── Step 4: Run full initializer protection tests ────────────────────
info "Running initializer protection integration tests..."
cargo test -p integration-tests --test initializer_protection -- --test-threads=1
success "Initializer protection integration tests passed"

# ── Step 5: Run EVM treasury governance tests ────────────────────────
# The MultisigTreasury suite covers batch atomicity (a failing member must roll
# the whole batch back), the pause gates, and the emergency-withdrawal escape
# hatch. These are governance invariants, so a failure blocks deployment.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "${SKIP_TREASURY_TESTS:-0}" = "1" ]; then
    warn "SKIP_TREASURY_TESTS=1 — skipping the Hardhat treasury suite"
elif ! command -v npx >/dev/null 2>&1; then
    error "npx not found; install the Node toolchain or set SKIP_TREASURY_TESTS=1"
    exit 1
elif [ ! -d "${REPO_ROOT}/node_modules" ]; then
    error "node_modules missing in ${REPO_ROOT}; run 'npm install' or set SKIP_TREASURY_TESTS=1"
    exit 1
else
    info "Running MultisigTreasury governance tests (batch + pause)..."
    (cd "$REPO_ROOT" && npx hardhat test test/MultisigTreasury.test.js)
    success "Treasury batch execution and pause tests passed"
fi

# ── Step 6: Deploy Soroban contracts ─────────────────────────────────
info "Deploying Soroban contracts to ${NETWORK_NAME}..."

# Format: "name:wasm_path:init_args"
# init_args is a JSON-style string passed verbatim to `stellar contract invoke`
CONTRACTS=(
    "trading:target/wasm32-unknown-unknown/release/trading.wasm"
    "messaging:target/wasm32-unknown-unknown/release/messaging.wasm"
    "academy:target/wasm32-unknown-unknown/release/academy_vesting.wasm"
    "did-registry:target/wasm32-unknown-unknown/release/did_registry.wasm"
    "identity-hub:target/wasm32-unknown-unknown/release/identity_hub.wasm"
    "verifiable-credentials:target/wasm32-unknown-unknown/release/verifiable_credentials.wasm"
    "cross-chain-router:target/wasm32-unknown-unknown/release/cross_chain_router.wasm"
)

declare -A CONTRACT_IDS

for entry in "${CONTRACTS[@]}"; do
    name="${entry%%:*}"
    wasm="${entry##*:}"

    if [ ! -f "$wasm" ]; then
        warn "WASM not found for ${name} at ${wasm}, skipping..."
        continue
    fi

    info "Deploying ${name}..."
    CONTRACT_ID=$(stellar contract deploy \
        --wasm "$wasm" \
        --source deployer \
        --network "$NETWORK_NAME" \
        2>&1) || {
        error "Failed to deploy ${name}"
        continue
    }

    CONTRACT_IDS[$name]="$CONTRACT_ID"
    success "Deployed ${name}: ${CONTRACT_ID}"
done

# ── Step 7: Initialize contracts ─────────────────────────────────────
info "Initializing deployed contracts..."

for name in "${!CONTRACT_IDS[@]}"; do
    contract_id="${CONTRACT_IDS[$name]}"

    info "Initializing ${name} (${contract_id})..."
    stellar contract invoke \
        --id "$contract_id" \
        --source deployer \
        --network "$NETWORK_NAME" \
        -- initialize 2>&1 || \
    stellar contract invoke \
        --id "$contract_id" \
        --source deployer \
        --network "$NETWORK_NAME" \
        -- init 2>&1 || {
        error "Failed to initialize ${name}"
        continue
    }
    success "Initialized ${name}"
done

# ── Step 8: Verify initializer protection ────────────────────────────
info "Verifying initializer protection (double-init must fail)..."

VERIFICATION_PASSED=true
for name in "${!CONTRACT_IDS[@]}"; do
    contract_id="${CONTRACT_IDS[$name]}"

    info "Testing double-init on ${name}..."
    # Try both function names; both should fail when the contract is
    # already initialized.
    if stellar contract invoke \
        --id "$contract_id" \
        --source deployer \
        --network "$NETWORK_NAME" \
        -- initialize 2>&1; then
        error "SECURITY FAILURE: ${name} allowed re-initialization via 'initialize'!"
        VERIFICATION_PASSED=false
    elif stellar contract invoke \
        --id "$contract_id" \
        --source deployer \
        --network "$NETWORK_NAME" \
        -- init 2>&1; then
        error "SECURITY FAILURE: ${name} allowed re-initialization via 'init'!"
        VERIFICATION_PASSED=false
    else
        success "${name} correctly rejected re-initialization"
    fi
done

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$VERIFICATION_PASSED" = true ]; then
    success "All contracts deployed and initializer protection verified!"
else
    error "SOME CONTRACTS FAILED INITIALIZER PROTECTION VERIFICATION"
    exit 1
fi
echo "════════════════════════════════════════════════════════════════"

# Print deployed contract addresses
echo ""
info "Deployed Contract Addresses:"
for name in "${!CONTRACT_IDS[@]}"; do
    echo "  ${name}: ${CONTRACT_IDS[$name]}"
done
