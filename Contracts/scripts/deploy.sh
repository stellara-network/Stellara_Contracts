#!/bin/bash
set -e

# Secure Deployment Script for Stellara Contracts

# Function to log messages
log() {
    echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')] $1"
}

# Check for required environment variables
if [ -z "$STELLAR_SECRET_KEY" ]; then
    log "Error: STELLAR_SECRET_KEY is not set."
    exit 1
fi

if [ -z "$STELLAR_NETWORK" ]; then
    log "Warning: STELLAR_NETWORK is not set. Defaulting to 'testnet'."
    STELLAR_NETWORK="testnet"
fi

if [ -z "$STELLAR_RPC_URL" ]; then
    if [ "$STELLAR_NETWORK" = "testnet" ]; then
        STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
    else
        log "Error: STELLAR_RPC_URL is not set."
        exit 1
    fi
fi

log "Configuration:"
log "  Network: $STELLAR_NETWORK"
log "  RPC URL: $STELLAR_RPC_URL"
log "  Secret Key: [HIDDEN]"

# Configure network if not exists
if ! stellar config network get "$STELLAR_NETWORK" >/dev/null 2>&1; then
    log "Configuring network '$STELLAR_NETWORK'..."
    stellar config network add \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "Test SDF Network ; September 2015" \
        "$STELLAR_NETWORK"
fi

# Configure identity securely
# We use a temporary identity 'deployer' to avoid exposing the key in logs
# The --secret-key argument is passed, but we suppress command echoing
log "Configuring deployer identity..."
stellar keys add deployer --secret-key "$STELLAR_SECRET_KEY" >/dev/null 2>&1

deploy_contract() {
    local wasm_path=$1
    local contract_name=$2
    
    if [ ! -f "$wasm_path" ]; then
        log "Warning: WASM file not found at $wasm_path. Skipping $contract_name."
        return
    fi
    
    log "Deploying $contract_name ($wasm_path)..."
    
    # Capture output to extract Contract ID
    local output
    output=$(stellar contract deploy \
        --wasm "$wasm_path" \
        --source deployer \
        --network "$STELLAR_NETWORK" \
        --no-wait 2>&1)
        
    # Check if deployment was successful (stellar cli might output the ID directly or in text)
    # Assuming output is the contract ID or contains it.
    # Typical output for deploy is the Contract ID.
    
    if [ $? -ne 0 ]; then
        log "Error deploying $contract_name: $output"
        exit 1
    fi
    
    local contract_id=$(echo "$output" | tail -n 1) # Assuming last line is ID
    
    log "Success! $contract_name deployed with ID: $contract_id"
    
    # Save to environment file
    echo "${contract_name^^}_ID=$contract_id" >> deployed_contracts.env
}

# Build contracts
log "Building contracts..."
cargo build --release --target wasm32-unknown-unknown

# Check for WASM files and deploy
# Based on package names in Cargo.toml
deploy_contract "target/wasm32-unknown-unknown/release/trading.wasm" "trading"
deploy_contract "target/wasm32-unknown-unknown/release/academy.wasm" "academy"
deploy_contract "target/wasm32-unknown-unknown/release/social_rewards.wasm" "social_rewards"
deploy_contract "target/wasm32-unknown-unknown/release/token.wasm" "token"

# Cleanup
log "Cleaning up..."
stellar keys rm deployer

log "Deployment complete. IDs saved to deployed_contracts.env"
