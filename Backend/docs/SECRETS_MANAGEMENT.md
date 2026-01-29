# Secrets Management Strategy

## Overview

This document outlines the secrets management approach for the Stellara project using **HashiCorp Vault** as the primary secret store, with **AWS Secrets Manager** as an alternative for AWS-deployed environments.

## Architecture

### Environments

- **Development**: Local Vault instance or HashiCorp Cloud Platform (HCP) Dev tier
- **Staging**: AWS Secrets Manager or Vault Enterprise
- **Production**: AWS Secrets Manager with encryption keys in AWS KMS or Vault Enterprise with HA setup

## Secrets Inventory

### Database Credentials

```
vault/data/stellara/database/postgres:
  - username: postgres
  - password: (rotated regularly)
  - host: db.example.com
  - port: 5432
  - database: stellara_db
```

### JWT & Authentication

```
vault/data/stellara/auth/jwt:
  - secret: (HS256 key, min 256 bits)
  
vault/data/stellara/auth/refresh-token:
  - secret: (separate key for refresh tokens)
```

### Redis Configuration

```
vault/data/stellara/redis/cache:
  - password: (Redis AUTH password)
  - host: redis.example.com
  - port: 6379
```

### API Keys & External Services

```
vault/data/stellara/external/stellar:
  - rpc-url: (Horizon RPC endpoint)
  - network-passphrase: (Test/Public Network)

vault/data/stellara/external/llm:
  - api-key: (e.g., OpenAI, Anthropic)
  - base-url: (optional, for self-hosted)
  
vault/data/stellara/external/stripe:
  - secret-key: (Stripe SK)
  - publishable-key: (Stripe PK)
```

### AWS Configuration (if using AWS Secrets Manager)

```
/stellara/database/postgres (JSON secret)
/stellara/jwt/secret (String secret)
/stellara/redis/password (String secret)
/stellara/stellar/config (JSON secret)
/stellara/llm/api-key (String secret)
```

## Vault Setup

### Installation

#### Local Development (HashiCorp Vault)

```bash
# Install Vault locally
# macOS
brew install vault

# Linux
wget https://releases.hashicorp.com/vault/1.15.0/vault_1.15.0_linux_amd64.zip
unzip vault_1.15.0_linux_amd64.zip
sudo mv vault /usr/local/bin/

# Windows (via Chocolatey)
choco install vault

# Start dev server (development mode only - no persistence)
vault server -dev

# In another terminal, set VAULT_ADDR
export VAULT_ADDR='http://localhost:8200'
vault login -method=token -path=auth/token/login <root_token>  # Default: "devroot"
```

#### Production (AWS Secrets Manager)

AWS Secrets Manager does not require local installation. Access is through:
- AWS CLI
- SDK (boto3, AWS SDK for Node.js, etc.)
- AWS Console

### Authentication Methods

#### Local Development (Token Auth)

```bash
# Login with token (development mode)
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='devroot'
```

#### Production (IAM Authentication)

```bash
# EC2 Instance: Uses IAM instance role automatically
# ECS Task: Uses task IAM role
# Lambda: Uses Lambda execution role
# On-premise: Use AppRole or Kubernetes auth

# AppRole (recommended for services)
vault write -force auth/approle/role/stellara-app/secret-id
```

### Initializing Vault with Secrets

```bash
# Enable KV v2 secrets engine (if not already enabled)
vault secrets enable -version=2 kv

# Create secret paths
vault kv put kv/stellara/database/postgres \
  username=postgres \
  password=<generate-strong-password> \
  host=localhost \
  port=5432 \
  database=stellara_db

vault kv put kv/stellara/auth/jwt \
  secret=<generate-256-bit-key>

vault kv put kv/stellara/redis/cache \
  password=<redis-password> \
  host=localhost \
  port=6379

vault kv put kv/stellara/external/stellar \
  rpc-url=https://horizon-testnet.stellar.org \
  network-passphrase="Test SDF Network ; September 2015"

vault kv put kv/stellara/external/llm \
  api-key=<your-llm-api-key> \
  base-url=https://api.openai.com/v1

vault kv put kv/stellara/external/stripe \
  secret-key=<stripe-sk> \
  publishable-key=<stripe-pk>
```

## Client Implementation

### For Backend (Node.js/NestJS)

See [VAULT_CLIENT_NODEJS.md](./VAULT_CLIENT_NODEJS.md)

### For Frontend (React/Next.js)

Frontend should **never** load secrets from Vault directly. Instead:
1. Backend exposes public configuration endpoints (e.g., `/api/config/public`)
2. Frontend calls these endpoints to get public Stripe key, RPC URLs, etc.
3. Sensitive operations use backend API calls

```typescript
// Example: Frontend loads public config
const publicConfig = await fetch('/api/config/public').then(r => r.json());
// { stripePublishableKey: '...', rpcUrl: '...' }
```

### For Contracts (Rust)

Contracts are on-chain and do not directly access Vault. Instead:
1. Deploy parameters (contract addresses, initial state) are provided at deploy time
2. Use Stellar Soroban's environment for runtime values
3. Deployment scripts load secrets from Vault

## Local Development Setup

### Option 1: Local Vault Instance

```bash
# 1. Start Vault dev server
vault server -dev

# 2. Export token and address
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='devroot'

# 3. Initialize secrets (use provision script below)
./scripts/vault/provision-dev.sh

# 4. Create .env.local (ignored by git)
cat > .env.local <<EOF
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=devroot
VAULT_NAMESPACE=kv
NODE_ENV=development
EOF

# 5. Run backend with vault-agent
npm run start:dev
```

### Option 2: .env.local Fallback (Insecure - Dev Only)

For convenience during development, the application can fall back to `.env.local` if Vault is unavailable:

```bash
# Create .env.local (added to .gitignore)
cat > .env.local <<EOF
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=devpassword
JWT_SECRET=dev-secret-key-change-in-production
REDIS_PASSWORD=
REDIS_HOST=localhost
REDIS_PORT=6379
STELLAR_RPC_URL=https://horizon-testnet.stellar.org
LLM_API_KEY=sk-dev-key
STRIPE_SECRET_KEY=sk_test_xxx
EOF

chmod 600 .env.local  # Restrict permissions
```

⚠️ **SECURITY WARNING**: `.env.local` is only for local development with non-sensitive values. Never commit this file.

## Secret Rotation

### Database Password Rotation

```bash
# 1. Generate new password
NEW_PASSWORD=$(openssl rand -base64 24)

# 2. Update Vault
vault kv patch kv/stellara/database/postgres password=$NEW_PASSWORD

# 3. Update database user password
psql -U postgres -c "ALTER USER postgres WITH PASSWORD '$NEW_PASSWORD';"

# 4. Rotate database connection in services
# Services will pick up new credentials on next restart or config reload

# 5. Update any backup/disaster recovery documentation
```

### JWT Secret Rotation

```bash
# 1. Generate new secret
NEW_JWT_SECRET=$(openssl rand -base64 48)

# 2. Add to Vault with version tracking
vault kv patch kv/stellara/auth/jwt \
  current=$NEW_JWT_SECRET \
  previous=$(vault kv get -field=current kv/stellara/auth/jwt)

# 3. Services pick up new secret on restart

# 4. Old tokens remain valid until expiration
```

### Stripe Key Rotation

Follow Stripe's standard key rotation:

```bash
# 1. Generate new API key in Stripe dashboard
# 2. Update Vault
vault kv patch kv/stellara/external/stripe secret-key=<new-key>

# 3. Services will use new key after restart
# 4. Keep old key for grace period in case of cached values
```

## Access Controls (RBAC)

### Development Team

```hcl
path "kv/data/stellara/database/*" {
  capabilities = ["read", "list"]
}

path "kv/data/stellara/auth/*" {
  capabilities = ["read", "list"]
}

path "kv/data/stellara/redis/*" {
  capabilities = ["read", "list"]
}

path "kv/data/stellara/external/*" {
  capabilities = ["read", "list"]
}
```

### DevOps / Infrastructure Team

```hcl
path "kv/data/stellara/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "sys/leases/renew" {
  capabilities = ["update"]
}
```

### Production Services (AppRole)

```hcl
path "kv/data/stellara/*" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}
```

### Secret Admins

Full access to manage all secrets and policies.

## AWS Secrets Manager Setup

### Creating Secrets

```bash
# Database credentials (JSON)
aws secretsmanager create-secret \
  --name /stellara/database/postgres \
  --secret-string '{
    "username": "postgres",
    "password": "generated-password",
    "host": "db.example.com",
    "port": 5432,
    "database": "stellara_db"
  }' \
  --region us-east-1

# JWT Secret
aws secretsmanager create-secret \
  --name /stellara/jwt/secret \
  --secret-string 'generated-jwt-secret' \
  --region us-east-1

# Encrypt with custom KMS key
aws secretsmanager create-secret \
  --name /stellara/redis/password \
  --secret-string 'redis-password' \
  --kms-key-id arn:aws:kms:us-east-1:ACCOUNT_ID:key/KEY_ID \
  --region us-east-1
```

### Rotation Policy

```bash
# Enable automatic rotation
aws secretsmanager rotate-secret \
  --secret-id /stellara/database/postgres \
  --rotation-rules AutomaticallyAfterDays=30 \
  --rotation-lambda-arn arn:aws:lambda:us-east-1:ACCOUNT:function:rotate-db-password \
  --region us-east-1
```

## CI/CD Integration

See [CI_CD_SECRETS.md](./CI_CD_SECRETS.md)

## Monitoring & Auditing

### Vault Audit Logging

```bash
# Enable audit logging
vault audit enable file file_path=/vault/logs/audit.log

# Check audit logs
tail -f /vault/logs/audit.log

# Filter for secret access
grep "PUT\|GET" /vault/logs/audit.log | grep "kv/stellara"
```

### AWS CloudTrail

```bash
# All Secrets Manager API calls are logged in CloudTrail
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --region us-east-1
```

### Alerts

- Set up CloudWatch alerts for failed secret retrieval
- Monitor Vault audit logs for unauthorized access attempts
- Alert on unusual access patterns

## Backup & Disaster Recovery

### Vault Backup

```bash
# Export all secrets (encrypted with Vault keys)
vault kv list -format=json kv/stellara/ | jq -r '.data.keys[]' | \
  xargs -I {} vault kv get -format=json kv/stellara/{} > /backup/vault-backup.json

# Encrypt backup
openssl enc -aes-256-cbc -salt -in /backup/vault-backup.json -out /backup/vault-backup.json.enc
```

### AWS Secrets Manager Backup

```bash
# AWS handles backup automatically with multi-region replication
# To replicate to another region:
aws secretsmanager replicate-secret-to-regions \
  --secret-id /stellara/database/postgres \
  --add-replica-regions Region=us-west-2 \
  --region us-east-1
```

## Troubleshooting

### Cannot Connect to Vault

```bash
# Check Vault server is running
curl http://localhost:8200/v1/sys/health

# Check VAULT_ADDR is set correctly
echo $VAULT_ADDR

# Check network connectivity
nc -zv localhost 8200
```

### Authentication Failed

```bash
# Re-login with token
vault login devroot

# Or use AppRole (production)
vault write -f auth/approle/role/stellara-app/secret-id
```

### Secret Not Found

```bash
# List available secrets
vault kv list kv/stellara/

# Check secret path is correct
vault kv get kv/stellara/database/postgres
```

## References

- [HashiCorp Vault Documentation](https://www.vaultproject.io/docs)
- [AWS Secrets Manager Guide](https://docs.aws.amazon.com/secretsmanager/)
- [OWASP Secret Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
