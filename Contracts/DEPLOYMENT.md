# Deployment Guide

## Secure Deployment (Recommended)

We use a secure deployment process that avoids hardcoding keys and ensures reproducible builds.

### 1. CI/CD Deployment (GitHub Actions)

The repository includes a GitHub Action workflow (`.github/workflows/deploy-contracts.yml`) that automatically deploys contracts when changes are pushed to `main` or manually triggered.

**Prerequisites:**

1.  Go to repository **Settings > Secrets and variables > Actions**.
2.  Add the following repository secrets:
    *   `STELLAR_DEPLOYER_SECRET_KEY`: The secret key (S...) of the account that will deploy the contracts. **DO NOT commit this key.**
    *   `STELLAR_RPC_URL`: (Optional) Custom RPC URL. Defaults to `https://soroban-testnet.stellar.org` for testnet.

**Triggering a Deploy:**

*   **Automatic:** Push to `main` triggers a deployment to Testnet.
*   **Manual:** Go to **Actions > Secure Contract Deployment**, click **Run workflow**, and select the network (testnet/mainnet).

**Artifacts:**

After a successful run, the workflow uploads a `deployed_contracts.env` artifact containing the new Contract IDs.

### 2. Local Secure Deployment

You can run the secure deployment script locally without exposing keys in your shell history.

1.  Set the environment variables (use a `.env` file or export them temporarily):

    ```bash
    export STELLAR_SECRET_KEY="S..."
    export STELLAR_NETWORK="testnet" # or "public"
    ```

2.  Run the deployment script:

    ```bash
    ./scripts/deploy.sh
    ```

3.  The script will output the deployed Contract IDs and save them to `deployed_contracts.env`.

---

## Local Development & Manual Deployment

*Use these steps for local testing or if you need manual control.*

### 1. Prepare Environment

```bash
# Install Stellar CLI if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://install.stellar.org | sh

# Verify installation
stellar version
```

### 2. Set Up Network Configuration

```bash
# Configure testnet
stellar config network add \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  testnet

# Set testnet as active network
stellar config network set testnet
```

### 3. Create Funded Account

```bash
# Generate new keypair
stellar keys generate my-account

# Fund account using testnet faucet
stellar network use testnet
# Visit: https://friendbot.stellar.org/?addr=GXXXXXX
```

### 4. Build WASM Binaries

```bash
# Build all contracts
cargo build --release --target wasm32-unknown-unknown

# Binaries located at:
# target/wasm32-unknown-unknown/release/trading.wasm
# target/wasm32-unknown-unknown/release/academy.wasm
# target/wasm32-unknown-unknown/release/social_rewards.wasm
# target/wasm32-unknown-unknown/release/token.wasm
```

### 5. Deploy Contracts

```bash
# Deploy trading contract
TRADING_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/trading.wasm \
  --source my-account \
  --network testnet \
  --no-wait)

# Deploy academy contract
ACADEMY_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/academy.wasm \
  --source my-account \
  --network testnet \
  --no-wait)

# Deploy social rewards contract
REWARDS_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/social_rewards.wasm \
  --source my-account \
  --network testnet \
  --no-wait)

# Deploy token contract
TOKEN_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/token.wasm \
  --source my-account \
  --network testnet \
  --no-wait)
```

### 6. Initialize Contracts

```bash
# Initialize each contract (example)
stellar contract invoke \
  --id $TRADING_ID \
  --source my-account \
  --network testnet \
  -- init

# ... (initialize others as needed)
```

### 7. Verify Deployment

```bash
# Check contract exists
stellar contract info --id $TRADING_ID --network testnet
```

## Contract Addresses (Testnet)

Update these after deployment:

```
Trading Contract:     [DEPLOYED_ADDRESS]
Academy Contract:     [DEPLOYED_ADDRESS]
Social Rewards:       [DEPLOYED_ADDRESS]
Token Contract:       [DEPLOYED_ADDRESS]
```

## Mainnet Migration

When ready for mainnet:

1. Replace testnet RPC URLs with mainnet
2. Use mainnet account credentials (set `STELLAR_NETWORK=public` and provide `STELLAR_SECRET_KEY` in CI/CD)
3. Re-deploy using mainnet network configuration
4. Update all contract addresses in frontend code

## Troubleshooting

### Build Issues

```bash
# Clean build
cargo clean
cargo build --release --target wasm32-unknown-unknown

# Check dependencies
cargo check
```

### Deployment Failures

```bash
# Verify account balance
stellar account info --source my-account --network testnet

# Check contract logs
stellar contract logs --id $CONTRACT_ID --network testnet
```
