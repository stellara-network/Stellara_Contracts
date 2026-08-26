# Secrets Management Strategy

## Overview

This document outlines the secrets management approach for the Stellara project using **HashiCorp Vault** as the primary secret store, with **AWS Secrets Manager** as an alternative for AWS-deployed environments.

---

## Runtime Secrets Masking

All secret values are masked before they reach application logs, exception
messages, or any diagnostic payload.  This is handled by `SecretsMaskingService`
(`src/config/secrets-masking.service.ts`).

### How It Works

| Layer | What is masked |
|---|---|
| Env-var substitution | Literal values of `JWT_SECRET`, `DB_PASSWORD`, `REDIS_URL`, `REDIS_PASSWORD`, `VAULT_TOKEN`, `LLM_API_KEY`, `STRIPE_SECRET_KEY`, and other known secret keys |
| Regex patterns | Bearer tokens, passwords in connection URLs (`redis://:pass@host`), query-string and JSON-encoded secret fields |
| Error masking | `Error.message` and `Error.stack` are sanitised before being logged |

### Consuming the Service

```typescript
import { SecretsMaskingService } from '../config/secrets-masking.service';

// Mask a free-form string
const safe = maskingService.mask(rawString);
logger.error(`Connection failed: ${safe}`);

// Mask an Error before rethrowing
throw maskingService.maskError(error);

// Mask an entire object (e.g. a request body)
const safeBody = maskingService.maskObject(req.body);
```

### Confirming Masking Is Active

If secrets masking is working correctly you will see tokens like
`***JWT_SECRET***` or `***DB_PASSWORD***` in log output instead of the
real values.

---

## Runtime Secret Rotation

`SecretsRotationService` (`src/config/secrets-rotation.service.ts`) provides
an in-process event bus for rotation signals.

### HTTP Rotation Endpoint

The application provides a secure HTTP endpoint for runtime secret rotation:
- **Endpoint**: `POST /api/secrets/rotate`
- **Authentication**: Requires JWT token with admin role
- **Validation**: New secret values are validated before application
- **Auditing**: All rotations are logged with actor, timestamp, and reason

#### Rotation Request Format

```json
{
  "secretKey": "JWT_SECRET",
  "newValue": "new-secret-value-here",
  "reason": "manual",
  "actorId": "user-123"
}
```

#### Supported Secret Keys

- `JWT_SECRET` - JWT signing key (min 32 chars, base64)
- `DB_PASSWORD` - Database password (min 16 chars)
- `REDIS_PASSWORD` - Redis password (min 8 chars)
- `REDIS_URL` - Redis connection URL (must match redis:// or rediss://)
- `VAULT_TOKEN` - Vault authentication token (min 20 chars)
- `LLM_API_KEY` - LLM service API key (format: sk-*)
- `STRIPE_SECRET_KEY` - Stripe secret key (format: sk_test_* or sk_live_*)
- `WEBHOOK_SECRET_KEY` - Webhook signature key (64-char hex)

#### Example Rotation via API

```bash
# Get admin token first
TOKEN=$(curl -X POST http://localhost:3000/api/auth/wallet/login \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"...","signature":"...","nonce":"..."}' | jq -r '.accessToken')

# Rotate JWT_SECRET
curl -X POST http://localhost:3000/api/secrets/rotate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "secretKey": "JWT_SECRET",
    "newValue": "new-secure-jwt-secret-base64-encoded",
    "reason": "manual"
  }'
```

### Registering a Rotation Handler

```typescript
import { SecretsRotationService } from '../config/secrets-rotation.service';

@Injectable()
export class MyService implements OnModuleInit {
  constructor(private readonly rotationService: SecretsRotationService) {}

  onModuleInit() {
    this.rotationService.onRotation('JWT_SECRET', async (evt) => {
      // New value is already in process.env / ConfigService
      await this.reloadSigningKey();
      this.logger.log(`JWT_SECRET reloaded at ${evt.rotatedAt}`);
    });
  }
}
```

### Triggering a Rotation via Script

The `rotate-secrets.sh` script provides command-line rotation:

```bash
# Rotate a single secret
./scripts/vault/rotate-secrets.sh jwt-secret
./scripts/vault/rotate-secrets.sh redis-password
./scripts/vault/rotate-secrets.sh db-password

# Rotate everything at once
./scripts/vault/rotate-secrets.sh all
```

You can also call the service programmatically (e.g. from a Vault renew
callback or a scheduled job):

```typescript
// After the new value is already loaded into process.env:
await rotationService.notifyRotation('JWT_SECRET', 'vault-renewal');

// Or bulk-notify:
await rotationService.notifyBulkRotation(['JWT_SECRET', 'DB_PASSWORD'], 'scheduled');
```

### Built-in Rotation Hooks

| Secret | Handler location | Effect |
|---|---|---|
| `REDIS_URL` | `RedisService.onModuleInit` | Reconnects all three Redis clients |
| `REDIS_PASSWORD` | `RedisService.onModuleInit` | Reconnects all three Redis clients |

### Rotation Validation Rules

Each secret type has specific validation rules that must be met before rotation:

| Secret | Validation Rule |
|---|---|
| `JWT_SECRET` | Minimum 32 characters, base64 characters only |
| `DB_PASSWORD` | Minimum 16 characters, no weak/default values |
| `REDIS_PASSWORD` | Minimum 8 characters, no weak/default values |
| `REDIS_URL` | Must match `redis://` or `rediss://` pattern |
| `VAULT_TOKEN` | Minimum 20 characters |
| `LLM_API_KEY` | Format: `sk-[a-zA-Z0-9]+`, minimum 10 characters |
| `STRIPE_SECRET_KEY` | Format: `sk_(test\|live)_[a-zA-Z0-9]+` |
| `WEBHOOK_SECRET_KEY` | Exactly 64 hexadecimal characters |

### Audit Logging

All rotation operations are logged to the audit log with:
- **Action Type**: `SECRET_ROTATED` or `SECRET_ROTATION_FAILED`
- **Actor ID**: User or service performing the rotation
- **Entity ID**: The secret key being rotated
- **Metadata**: Includes rotation reason, old value (masked), and new value length

Failed rotations are also audited with the specific error reason.

---

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

## Secret Rotation Procedures

### Operator Procedures for Secret Rotation

#### 1. Prerequisites
- Ensure you have admin privileges (JWT token with admin role)
- Verify the application is running and accessible
- Have the new secret value ready and validated
- Ensure backup/rollback plan is in place

#### 2. Rotation Steps via HTTP API

```bash
# Step 1: Authenticate as admin
TOKEN=$(curl -X POST http://localhost:3000/api/auth/wallet/login \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"ADMIN_PUBLIC_KEY","signature":"SIGNATURE","nonce":"NONCE"}' \
  | jq -r '.accessToken')

# Step 2: Rotate the secret
curl -X POST http://localhost:3000/api/secrets/rotate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "secretKey": "JWT_SECRET",
    "newValue": "new-secure-value-here",
    "reason": "manual"
  }'

# Step 3: Verify rotation success
curl -X GET http://localhost:3000/api/secrets/status \
  -H "Authorization: Bearer $TOKEN"
```

#### 3. Rotation Steps via Script

```bash
# Using the dedicated rotation script
./scripts/vault/rotate-secrets.sh jwt-secret

# The script will:
# 1. Validate the new secret format
# 2. Update Vault if enabled
# 3. Notify the running application via HTTP
# 4. Wait for confirmation
# 5. Log the rotation to audit log
```

#### 4. Emergency Rollback

If a rotation causes issues:

```bash
# 1. Revert the secret in Vault to previous version
vault kv rollback kv/stellara/auth/jwt -version=previous_version

# 2. Force rotation of the reverted value
./scripts/vault/rotate-secrets.sh jwt-secret

# 3. Monitor application logs for errors
# 4. Verify connections are re-established
```

### Database Password Rotation

```bash
# 1. Generate new password
NEW_PASSWORD=$(openssl rand -base64 24)

# 2. Update Vault
vault kv patch kv/stellara/database/postgres password=$NEW_PASSWORD

# 3. Update database user password
psql -U postgres -c "ALTER USER postgres WITH PASSWORD '$NEW_PASSWORD';"

# 4. Rotate via HTTP endpoint (triggers connection pool refresh)
curl -X POST http://localhost:3000/api/secrets/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secretKey":"DB_PASSWORD","newValue":"'$NEW_PASSWORD'","reason":"manual"}'

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

# 3. Rotate via HTTP endpoint
curl -X POST http://localhost:3000/api/secrets/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secretKey":"JWT_SECRET","newValue":"'$NEW_JWT_SECRET'","reason":"manual"}'

# 4. Old tokens remain valid until expiration
# 5. Monitor for authentication errors during transition
```

### Stripe Key Rotation

Follow Stripe's standard key rotation:

```bash
# 1. Generate new API key in Stripe dashboard
# 2. Update Vault
vault kv patch kv/stellara/external/stripe secret-key=<new-key>

# 3. Rotate via HTTP endpoint
curl -X POST http://localhost:3000/api/secrets/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secretKey":"STRIPE_SECRET_KEY","newValue":"<new-key>","reason":"manual"}'

# 4. Services will use new key after rotation
# 5. Keep old key for grace period in case of cached values
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
