#!/bin/bash

# Secrets Rotation Script
# This script provides command-line interface for rotating secrets at runtime
# with validation, Vault integration, and HTTP endpoint notification.
#
# Usage:
#   ./scripts/vault/rotate-secrets.sh jwt-secret        # Rotate JWT_SECRET
#   ./scripts/vault/rotate-secrets.sh redis-password    # Rotate REDIS_PASSWORD
#   ./scripts/vault/rotate-secrets.sh db-password       # Rotate DB_PASSWORD
#   ./scripts/vault/rotate-secrets.sh all                # Rotate all secrets
#   ./scripts/vault/rotate-secrets.sh list              # List rotatable secrets

set -euo pipefail

# ── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

# ── Defaults ─────────────────────────────────────────────────────────────────
: "${VAULT_ADDR:=http://localhost:8200}"
: "${VAULT_TOKEN:=devroot}"
: "${BACKEND_API:=http://localhost:3000}"
: "${ADMIN_TOKEN:=}"

export VAULT_ADDR VAULT_TOKEN

SECRET_TYPE="${1:-list}"

# ── Secret mapping ───────────────────────────────────────────────────────────
declare -A SECRET_MAP=(
  ["jwt-secret"]="JWT_SECRET"
  ["redis-password"]="REDIS_PASSWORD"
  ["redis-url"]="REDIS_URL"
  ["db-password"]="DB_PASSWORD"
  ["vault-token"]="VAULT_TOKEN"
  ["llm-api-key"]="LLM_API_KEY"
  ["stripe-secret-key"]="STRIPE_SECRET_KEY"
  ["webhook-secret-key"]="WEBHOOK_SECRET_KEY"
)

declare -A VAULT_PATHS=(
  ["JWT_SECRET"]="kv/stellara/auth/jwt"
  ["REDIS_PASSWORD"]="kv/stellara/redis/cache"
  ["REDIS_URL"]="kv/stellara/redis/cache"
  ["DB_PASSWORD"]="kv/stellara/database/postgres"
  ["VAULT_TOKEN"]=""  # VAULT_TOKEN is managed externally
  ["LLM_API_KEY"]="kv/stellara/external/llm"
  ["STRIPE_SECRET_KEY"]="kv/stellara/external/stripe"
  ["WEBHOOK_SECRET_KEY"]="kv/stellara/external/stripe"
)

# ── Preflight checks ─────────────────────────────────────────────────────────
check_vault() {
  echo -e "${YELLOW}Checking Vault connection at ${VAULT_ADDR}...${NC}"
  if ! vault status > /dev/null 2>&1; then
    echo -e "${RED}Error: Vault is not running or unreachable at ${VAULT_ADDR}!${NC}"
    echo "Start Vault with: vault server -dev"
    exit 1
  fi
  echo -e "${GREEN}✓ Vault is running${NC}"
}

check_backend() {
  echo -e "${YELLOW}Checking backend API at ${BACKEND_API}...${NC}"
  if ! curl -s -f "${BACKEND_API}/health" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Backend API is not reachable at ${BACKEND_API}${NC}"
    echo "Continuing with Vault update only (HTTP notification will be skipped)"
    return 1
  fi
  echo -e "${GREEN}✓ Backend API is running${NC}"
  return 0
}

ensure_admin_token() {
  if [ -z "$ADMIN_TOKEN" ]; then
    echo -e "${YELLOW}No ADMIN_TOKEN set. Please provide admin JWT token:${NC}"
    echo -n "Enter admin token: "
    read -r ADMIN_TOKEN
    export ADMIN_TOKEN
  fi
}

# ── Validation functions ────────────────────────────────────────────────────
validate_jwt_secret() {
  local secret="$1"
  if [ ${#secret} -lt 32 ]; then
    echo -e "${RED}Error: JWT_SECRET must be at least 32 characters${NC}"
    return 1
  fi
  if ! [[ "$secret" =~ ^[A-Za-z0-9+/=_\-]{32,}$ ]]; then
    echo -e "${RED}Error: JWT_SECRET must contain only valid base64 characters${NC}"
    return 1
  fi
  return 0
}

validate_db_password() {
  local secret="$1"
  if [ ${#secret} -lt 16 ]; then
    echo -e "${RED}Error: DB_PASSWORD must be at least 16 characters${NC}"
    return 1
  fi
  return 0
}

validate_redis_password() {
  local secret="$1"
  if [ ${#secret} -lt 8 ]; then
    echo -e "${RED}Error: REDIS_PASSWORD must be at least 8 characters${NC}"
    return 1
  fi
  return 0
}

validate_redis_url() {
  local url="$1"
  if ! [[ "$url" =~ ^rediss?:// ]]; then
    echo -e "${RED}Error: REDIS_URL must start with redis:// or rediss://${NC}"
    return 1
  fi
  return 0
}

validate_llm_api_key() {
  local key="$1"
  if [ ${#key} -lt 10 ]; then
    echo -e "${RED}Error: LLM_API_KEY must be at least 10 characters${NC}"
    return 1
  fi
  if ! [[ "$key" =~ ^sk-[a-zA-Z0-9]+$ ]]; then
    echo -e "${RED}Error: LLM_API_KEY must match format sk-[a-zA-Z0-9]+${NC}"
    return 1
  fi
  return 0
}

validate_stripe_secret_key() {
  local key="$1"
  if ! [[ "$key" =~ ^sk_(test|live)_[a-zA-Z0-9]+$ ]]; then
    echo -e "${RED}Error: STRIPE_SECRET_KEY must match format sk_test_* or sk_live_*${NC}"
    return 1
  fi
  return 0
}

validate_webhook_secret_key() {
  local key="$1"
  if ! [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo -e "${RED}Error: WEBHOOK_SECRET_KEY must be a 64-character hexadecimal string${NC}"
    return 1
  fi
  return 0
}

# ── Rotation functions ───────────────────────────────────────────────────────
rotate_secret() {
  local secret_type="$1"
  local secret_key="${SECRET_MAP[$secret_type]}"
  local vault_path="${VAULT_PATHS[$secret_key]}"

  if [ -z "$secret_key" ]; then
    echo -e "${RED}Error: Unknown secret type: $secret_type${NC}"
    echo "Use 'list' to see available secret types"
    exit 1
  fi

  echo -e "${CYAN}Rotating ${secret_key}...${NC}"

  # Check Vault connection
  check_vault

  # Generate new secret value
  local new_value
  case "$secret_type" in
    jwt-secret)
      new_value=$(openssl rand -base64 48)
      validate_jwt_secret "$new_value" || exit 1
      ;;
    redis-password)
      new_value=$(openssl rand -base64 24)
      validate_redis_password "$new_value" || exit 1
      ;;
    db-password)
      new_value=$(openssl rand -base64 24)
      validate_db_password "$new_value" || exit 1
      ;;
    redis-url)
      echo -e "${YELLOW}Enter new REDIS_URL (must match redis:// or rediss://):${NC}"
      read -r new_value
      validate_redis_url "$new_value" || exit 1
      ;;
    llm-api-key)
      echo -e "${YELLOW}Enter new LLM_API_KEY (format: sk-*):${NC}"
      read -r new_value
      validate_llm_api_key "$new_value" || exit 1
      ;;
    stripe-secret-key)
      echo -e "${YELLOW}Enter new STRIPE_SECRET_KEY (format: sk_test_* or sk_live_*):${NC}"
      read -r new_value
      validate_stripe_secret_key "$new_value" || exit 1
      ;;
    webhook-secret-key)
      new_value=$(openssl rand -hex 32)
      validate_webhook_secret_key "$new_value" || exit 1
      ;;
    vault-token)
      echo -e "${YELLOW}VAULT_TOKEN rotation is managed externally. Skipping.${NC}"
      return 0
      ;;
  esac

  # Update Vault if path is defined
  if [ -n "$vault_path" ]; then
    echo -e "${CYAN}  → Updating Vault at ${vault_path}...${NC}"
    case "$secret_key" in
      JWT_SECRET)
        vault kv put "$vault_path" secret="$new_value"
        ;;
      REDIS_PASSWORD)
        vault kv patch "$vault_path" password="$new_value"
        ;;
      REDIS_URL)
        echo -e "${YELLOW}  ⚠ REDIS_URL rotation requires manual Vault update${NC}"
        echo "  vault kv patch $vault_path url=\"$new_value\""
        ;;
      DB_PASSWORD)
        vault kv patch "$vault_path" password="$new_value"
        # Update database user password if psql is available
        if command -v psql &>/dev/null; then
          echo -e "${CYAN}  → Updating Postgres user password...${NC}"
          DB_HOST=$(vault kv get -field=host "$vault_path" 2>/dev/null || echo "localhost")
          DB_PORT=$(vault kv get -field=port "$vault_path" 2>/dev/null || echo "5432")
          DB_USER=$(vault kv get -field=username "$vault_path" 2>/dev/null || echo "postgres")
          PGPASSWORD="$new_value" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" \
            -c "ALTER USER ${DB_USER} WITH PASSWORD '${new_value}';" \
            && echo -e "${GREEN}  ✓ Postgres password updated${NC}" \
            || echo -e "${YELLOW}  ⚠ Could not update Postgres password automatically${NC}"
        fi
        ;;
      LLM_API_KEY)
        vault kv patch "$vault_path" api-key="$new_value"
        ;;
      STRIPE_SECRET_KEY)
        vault kv patch "$vault_path" secret-key="$new_value"
        ;;
      WEBHOOK_SECRET_KEY)
        vault kv patch "$vault_path" webhook-secret-key="$new_value"
        ;;
    esac
    echo -e "${GREEN}  ✓ Vault updated${NC}"
  fi

  # Notify backend via HTTP endpoint
  if check_backend; then
    ensure_admin_token
    echo -e "${CYAN}  → Notifying backend via HTTP endpoint...${NC}"
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "${BACKEND_API}/api/secrets/rotate" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "{\"secretKey\":\"${secret_key}\",\"newValue\":\"${new_value}\",\"reason\":\"manual\"}" \
      2>/dev/null || echo "000")

    if [ "${HTTP_STATUS}" = "200" ] || [ "${HTTP_STATUS}" = "201" ]; then
      echo -e "${GREEN}  ✓ Backend notified successfully (HTTP ${HTTP_STATUS})${NC}"
    else
      echo -e "${YELLOW}  ⚠ Backend notification failed (HTTP ${HTTP_STATUS})${NC}"
      echo "  Secret has been updated in Vault but not applied to runtime"
    fi
  else
    echo -e "${YELLOW}  ⚠ Backend notification skipped (backend not running)${NC}"
    echo "  Secret has been updated in Vault but not applied to runtime"
  fi

  echo -e "${GREEN}✓ ${secret_key} rotation complete${NC}"
}

rotate_all() {
  echo -e "${CYAN}Rotating all secrets...${NC}"
  for secret_type in "${!SECRET_MAP[@]}"; do
    if [ "$secret_type" != "vault-token" ]; then
      rotate_secret "$secret_type"
      echo ""
    fi
  done
  echo -e "${GREEN}✓ All secrets rotated${NC}"
}

list_secrets() {
  echo -e "${CYAN}Available secret types for rotation:${NC}"
  echo ""
  for secret_type in "${!SECRET_MAP[@]}"; do
    secret_key="${SECRET_MAP[$secret_type]}"
    echo "  ${secret_type} → ${secret_key}"
  done
  echo ""
  echo "Usage: $0 <secret-type>"
  echo "Example: $0 jwt-secret"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "${SECRET_TYPE}" in
  jwt-secret|redis-password|redis-url|db-password|vault-token|llm-api-key|stripe-secret-key|webhook-secret-key)
    rotate_secret "$SECRET_TYPE"
    ;;
  all)
    rotate_all
    ;;
  list|--help|-h)
    list_secrets
    ;;
  *)
    echo -e "${RED}Unknown secret type: ${SECRET_TYPE}${NC}"
    echo ""
    list_secrets
    exit 1
    ;;
esac
