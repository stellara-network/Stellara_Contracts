#!/bin/bash

# Vault Development Secrets Provisioning Script
# This script initializes Vault with development secrets for the Stellara project

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Vault is running
echo -e "${YELLOW}Checking Vault connection...${NC}"
if ! vault status > /dev/null 2>&1; then
    echo -e "${RED}Error: Vault is not running!${NC}"
    echo "Start Vault with: vault server -dev"
    exit 1
fi

echo -e "${GREEN}✓ Vault is running${NC}"

# Check if VAULT_TOKEN is set
if [ -z "$VAULT_TOKEN" ]; then
    echo -e "${YELLOW}VAULT_TOKEN not set. Setting to devroot...${NC}"
    export VAULT_TOKEN='devroot'
fi

echo -e "${YELLOW}Using Vault at: $VAULT_ADDR${NC}"

# Enable KV v2 secrets engine if not already enabled
echo -e "${YELLOW}Configuring KV v2 secrets engine...${NC}"
if vault secrets list | grep -q "^kv/"; then
    echo -e "${GREEN}✓ KV v2 already enabled${NC}"
else
    vault secrets enable -version=2 kv
    echo -e "${GREEN}✓ KV v2 enabled${NC}"
fi

# Create Development Secrets
echo -e "${YELLOW}Creating development secrets...${NC}"

# Database
echo "→ Creating database credentials..."
vault kv put kv/stellara/database/postgres \
    host=localhost \
    port=5432 \
    username=postgres \
    password=devpassword \
    database=stellara_db
echo -e "${GREEN}✓ Database credentials created${NC}"

# JWT
echo "→ Creating JWT secret..."
JWT_SECRET=$(openssl rand -base64 48)
vault kv put kv/stellara/auth/jwt \
    secret=$JWT_SECRET
echo -e "${GREEN}✓ JWT secret created: $JWT_SECRET${NC}"

# Redis
echo "→ Creating Redis configuration..."
vault kv put kv/stellara/redis/cache \
    host=localhost \
    port=6379 \
    password=""
echo -e "${GREEN}✓ Redis configuration created${NC}"

# Stellar
echo "→ Creating Stellar configuration..."
vault kv put kv/stellara/external/stellar \
    rpc-url=https://horizon-testnet.stellar.org \
    network-passphrase="Test SDF Network ; September 2015"
echo -e "${GREEN}✓ Stellar configuration created${NC}"

# LLM
echo "→ Creating LLM configuration..."
vault kv put kv/stellara/external/llm \
    api-key=sk-dev-key-for-testing \
    base-url=https://api.openai.com/v1
echo -e "${GREEN}✓ LLM configuration created${NC}"

# Stripe (optional)
echo "→ Creating Stripe configuration..."
vault kv put kv/stellara/external/stripe \
    secret-key=sk_test_development \
    publishable-key=pk_test_development
echo -e "${GREEN}✓ Stripe configuration created${NC}"

# Verify secrets
echo -e "${YELLOW}Verifying secrets...${NC}"
echo "Available secrets:"
vault kv list kv/stellara/ | sed 's/^/  /'

echo -e "${GREEN}✓ All secrets created successfully!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Set environment variables:"
echo "   export VAULT_ADDR='http://localhost:8200'"
echo "   export VAULT_TOKEN='devroot'"
echo ""
echo "2. Create Backend/.env with VAULT_ENABLED=true"
echo ""
echo "3. Start the backend:"
echo "   cd Backend && npm run start:dev"
echo ""
echo "4. View a secret:"
echo "   vault kv get kv/stellara/database/postgres"
