# Local Secrets Setup for Developers

## Quick Start

Follow one of these methods to set up local secrets for development.

## Option 1: HashiCorp Vault (Recommended)

### Installation

**macOS:**
```bash
brew install vault
```

**Linux (Ubuntu/Debian):**
```bash
wget https://releases.hashicorp.com/vault/1.15.0/vault_1.15.0_linux_amd64.zip
unzip vault_1.15.0_linux_amd64.zip
sudo mv vault /usr/local/bin/
```

**Windows (Chocolatey):**
```bash
choco install vault
```

**Windows (Manual):**
1. Download from [HashiCorp Vault Releases](https://releases.hashicorp.com/vault/)
2. Extract and add to PATH

### Starting Vault Dev Server

```bash
# Start dev server (development mode only - no persistence)
vault server -dev

# In another terminal, initialize environment
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='devroot'  # Default token for dev server

# Verify connection
vault status
```

The dev server includes:
- ✅ Unsealed by default
- ✅ HTTP (not HTTPS)
- ✅ Token auth enabled
- ❌ No persistent storage (data lost on restart)

### Initialize Development Secrets

Run the provision script:

```bash
# From Backend directory
./scripts/vault/provision-dev.sh
```

Or manually create secrets:

```bash
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='devroot'

# Database
vault kv put kv/stellara/database/postgres \
  host=localhost \
  port=5432 \
  username=postgres \
  password=devpassword \
  database=stellara_db

# JWT
vault kv put kv/stellara/auth/jwt \
  secret=your-dev-jwt-secret-key-min-32-chars

# Redis
vault kv put kv/stellara/redis/cache \
  host=localhost \
  port=6379 \
  password=""

# Stellar
vault kv put kv/stellara/external/stellar \
  rpc-url=https://horizon-testnet.stellar.org \
  network-passphrase="Test SDF Network ; September 2015"

# LLM (optional, use dummy key for testing)
vault kv put kv/stellara/external/llm \
  api-key=sk-dev-key \
  base-url=https://api.openai.com/v1

# Stripe (optional, use test keys)
vault kv put kv/stellara/external/stripe \
  secret-key=sk_test_xxx \
  publishable-key=pk_test_yyy
```

### Configuration

Create `.env` in `Backend/` directory:

```dotenv
# Vault Configuration
VAULT_ENABLED=true
VAULT_ADDR=http://localhost:8200
VAULT_NAMESPACE=kv
VAULT_TOKEN=devroot

# AWS Secrets Manager (disabled for local dev)
AWS_SECRETS_MANAGER_ENABLED=false

# Application
NODE_ENV=development
PORT=3000

# Fallback values
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=devpassword
DB_DATABASE=stellara_db
JWT_SECRET=dev-secret-key
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Running Backend

```bash
cd Backend

# Make sure Vault is running in another terminal
# vault server -dev

# Install dependencies
npm install

# Start dev server
npm run start:dev
```

### Checking Vault Secrets

```bash
# List all secrets
vault kv list kv/stellara/

# Get specific secret
vault kv get kv/stellara/database/postgres

# Get single field
vault kv get -field=password kv/stellara/database/postgres

# Delete secret (if needed)
vault kv delete kv/stellara/database/postgres
```

### Stopping Vault

```bash
# Stop the server gracefully
# Press Ctrl+C in the terminal where vault server -dev is running

# For production, use:
# pkill vault
```

---

## Option 2: Environment File Fallback (.env.local)

⚠️ **SECURITY WARNING**: This method stores secrets in plaintext. Only use for local development with non-sensitive values.

### Setup

```bash
cd Backend

# Create .env.local (ignored by git)
cat > .env.local <<EOF
# Database
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=postgres
DB_PASSWORD=devpassword
DB_DATABASE=stellara_db

# Authentication
JWT_SECRET=your-dev-jwt-secret-key-min-32-chars
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_QUEUE_DB=1

# External Services
STELLAR_RPC_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
LLM_API_KEY=sk-dev-key-for-testing
STRIPE_SECRET_KEY=sk_test_xxx

# Application
NODE_ENV=development
PORT=3000
VAULT_ENABLED=false
AWS_SECRETS_MANAGER_ENABLED=false
EOF

# Restrict permissions (optional but recommended)
chmod 600 .env.local
```

### Running Backend

```bash
cd Backend
npm install
npm run start:dev
```

The application will automatically load `.env.local` as a fallback when Vault is unavailable.

---

## Option 3: Docker Compose (Complete Stack)

Run entire development stack including Vault:

### Update docker-compose.yml

```yaml
version: '3.8'

services:
  # Vault
  vault:
    image: vault:latest
    container_name: stellara_vault
    environment:
      VAULT_DEV_ROOT_TOKEN_ID: devroot
      VAULT_DEV_LISTEN_ADDRESS: 0.0.0.0:8200
    ports:
      - "8200:8200"
    cap_add:
      - IPC_LOCK
    volumes:
      - ./scripts/vault/init.sh:/init.sh:ro
    command: server -dev
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8200/v1/sys/health"]
      interval: 5s
      timeout: 3s
      retries: 5

  # Database
  db:
    image: postgres:15-alpine
    container_name: stellara_db
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: stellara_db
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  # Redis
  redis:
    image: redis:7-alpine
    container_name: stellara_redis
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  # Backend
  backend:
    build:
      context: ./Backend
      dockerfile: Dockerfile.dev
    container_name: stellara_backend
    environment:
      NODE_ENV: development
      VAULT_ENABLED: "true"
      VAULT_ADDR: http://vault:8200
      VAULT_NAMESPACE: kv
      VAULT_TOKEN: devroot
      DB_HOST: db
      DB_PORT: 5432
      DB_USERNAME: postgres
      DB_PASSWORD: devpassword
      DB_DATABASE: stellara_db
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "3000:3000"
    depends_on:
      vault:
        condition: service_healthy
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./Backend/src:/app/src
      - ./Backend/test:/app/test
    command: npm run start:dev

volumes:
  postgres_data:
```

### Create Dockerfile.dev

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
```

### Startup Script for Vault Init

Create `scripts/vault/init.sh`:

```bash
#!/bin/sh

# Wait for Vault to start
sleep 5

# Export Vault configuration
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='devroot'

# Initialize secrets
vault kv put kv/stellara/database/postgres \
  host=db \
  port=5432 \
  username=postgres \
  password=devpassword \
  database=stellara_db

vault kv put kv/stellara/auth/jwt \
  secret=dev-secret-key-min-32-characters

vault kv put kv/stellara/redis/cache \
  host=redis \
  port=6379 \
  password=""

vault kv put kv/stellara/external/stellar \
  rpc-url=https://horizon-testnet.stellar.org \
  network-passphrase="Test SDF Network ; September 2015"

vault kv put kv/stellara/external/llm \
  api-key=sk-dev-key \
  base-url=https://api.openai.com/v1

echo "Vault initialization complete"
```

### Running the Stack

```bash
# Start all services
docker-compose up -d

# Check logs
docker-compose logs -f backend

# Stop services
docker-compose down
```

---

## Troubleshooting

### Vault Connection Failed

```bash
# Check Vault is running
vault status

# If not running, start it
vault server -dev

# Check environment variables
echo $VAULT_ADDR
echo $VAULT_TOKEN

# Test connection
curl http://localhost:8200/v1/sys/health
```

### Secret Not Found

```bash
# Check if secret exists
vault kv list kv/stellara/

# List specific path
vault kv list kv/stellara/database/

# Get secret details
vault kv get kv/stellara/database/postgres
```

### Database Connection Error

```bash
# Check PostgreSQL is running
pg_isready -h localhost -p 5433

# Check with Docker
docker ps | grep postgres

# Verify credentials match .env
# DB_HOST should be "localhost" or "db" (if using Docker)
```

### .env.local Not Loading

```bash
# Verify file exists
ls -la Backend/.env.local

# Check it's in .gitignore
grep ".env.local" .gitignore

# Verify permissions
chmod 600 Backend/.env.local

# Check NestJS ConfigModule loads it
# Should see log: "VAULT_ENABLED" in config or ".env.local" fallback message
```

### Redis Connection Issues

```bash
# Check Redis is running
redis-cli ping
# Should return: PONG

# If using Docker:
docker exec stellara_redis redis-cli ping

# Check Redis port
netstat -tuln | grep 6379
```

---

## Security Best Practices

✅ **DO:**
- Use Vault for production-like dev environments
- Store only non-sensitive test values in .env.local
- Restrict .env.local file permissions (chmod 600)
- Rotate JWT secrets periodically
- Use test/dummy credentials for external services
- Add .env.local to .gitignore

❌ **DON'T:**
- Commit .env.local to git
- Use production credentials locally
- Share .env.local between developers
- Store real API keys in .env.local
- Hardcode secrets in code
- Leave Vault running with sensitive data

---

## Working with Multiple Branches

If working on multiple feature branches:

```bash
# Each branch can have its own .env.local
# Git will ignore all .env.local files

# Switch branches safely
git checkout feature-branch
# Your .env.local persists (not tracked)

# If you need branch-specific secrets:
cp .env.local .env.local.backup
# Make changes to .env.local for this branch
# When switching back:
git checkout main
git checkout .env.local  # Restore from git
```

---

## Getting Help

For issues, check:

1. **Vault logs**: `vault server -dev` terminal output
2. **Application logs**: `npm run start:dev` output
3. **Vault secrets**: `vault kv list kv/stellara/`
4. **Database**: `psql -U postgres -d stellara_db -c "\\dt"`
5. **Documentation**: [Backend README](../README.md)

Contact the team or check the team wiki for environment-specific issues.
