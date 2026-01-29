# Secret Scanning and Prevention

## Preventing Secrets in Git

Add to `.gitignore`:

```gitignore
# Environment and Secrets
.env
.env.local
.env.*.local
.env.backup
.env.prod
.env.staging
.env.development
vault/

# IDE
.vscode/settings.json
.idea/
*.swp
*.swo

# Dependencies
node_modules/
dist/
build/

# Logs
*.log
logs/

# OS
.DS_Store
Thumbs.db

# Testing
coverage/
.nyc_output/

# Build
*.tsbuildinfo
```

## Detecting Existing Secrets

### Using git-secrets

Install and configure:

```bash
# Install git-secrets
brew install git-secrets  # macOS
# or
git clone https://github.com/awslabs/git-secrets.git
cd git-secrets
make install

# Initialize in your repo
cd /path/to/Stellara_Contracts
git secrets --install

# Add patterns to detect
git secrets --register-aws

# (Optional) Add custom patterns
git secrets --add 'DB_PASSWORD=.*'
git secrets --add 'JWT_SECRET=.*'
git secrets --add 'VAULT_TOKEN=.*'
```

### Using TruffleHog

```bash
# Install
pip install truffleHog

# Scan repository
truffleHog filesystem /path/to/Stellara_Contracts --json

# Scan with entropy check
truffleHog filesystem /path/to/Stellara_Contracts \
  --entropy-scan \
  --json
```

### Using detect-secrets

```bash
# Install
pip install detect-secrets

# Scan repository
detect-secrets scan /path/to/Stellara_Contracts

# Baseline scan (first time)
detect-secrets scan \
  --baseline .secrets.baseline \
  /path/to/Stellara_Contracts

# Audit existing baseline
detect-secrets audit .secrets.baseline
```

### Using OWASP Secrets

```bash
# Install npm globally
npm install -g owasp-secrets

# Scan directory
owasp-secrets --recursive /path/to/Stellara_Contracts
```

## Current Repository Scan Results

### Files to Check

Files that historically may contain secrets:

1. ✅ `Backend/.env.example` - EXAMPLE ONLY (no real secrets)
2. ✅ `Backend/docker-compose.yml` - Uses environment variables
3. ✅ `Backend/src/**/*.ts` - Check for hardcoded secrets
4. ✅ `Frontend/` - Frontend should not contain secrets
5. ✅ `Contracts/` - Smart contracts don't contain secrets

### Known Safe Files

These files are safe and don't contain secrets:

- `**/*.md` - Documentation files
- `**/*.json` - Package configs (no secrets)
- `**/*.ts` - Application code (should not have hardcoded secrets)
- `**/*.rs` - Rust contract code

## Cleanup Instructions

If secrets were found:

### Step 1: Identify Leaked Secrets

```bash
# Find all .env files in history
git log --all --full-history -S 'DB_PASSWORD=' -- '*.env'

# Find commits with secrets
git log -p -S 'password' | head -100
```

### Step 2: Remove from History

**Option A: Using BFG Repo-Cleaner (Recommended)**

```bash
# Install BFG
brew install bfg  # macOS

# Create file with patterns to remove
cat > secrets.txt <<EOF
VAULT_TOKEN=.*
DB_PASSWORD=.*
JWT_SECRET=.*
API_KEY=.*
EOF

# Remove secrets
bfg --replace-text secrets.txt /path/to/Stellara_Contracts

# Clean up
cd /path/to/Stellara_Contracts
git reflog expire --expire=now --all
git gc --prune=now
```

**Option B: Using git-filter-repo**

```bash
# Install
pip install git-filter-repo

# Remove file from history
git filter-repo --path Backend/.env --invert-paths

# Or replace file content
git filter-repo --path Backend/.env --replace-text replacements.txt
```

### Step 3: Force Push

```bash
# After cleaning, push with force (only if you own the repo)
git push origin main --force-with-lease
```

### Step 4: Rotate Secrets

```bash
# All exposed secrets must be rotated:
# - DB passwords
# - JWT secrets
# - API keys
# - Vault tokens

# Update Vault
vault kv patch kv/stellara/database/postgres password=<new-password>
vault kv patch kv/stellara/auth/jwt secret=<new-secret>

# Restart services to pick up new secrets
docker-compose restart
```

## Setting Up Pre-Commit Hooks

Create `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.4.0
    hooks:
      - id: detect-secrets
        args: ['--baseline', '.secrets.baseline']
        exclude: package.lock.json

  - repo: https://github.com/awslabs/git-secrets.git
    rev: master
    hooks:
      - id: git-secrets
        stages: [commit]
        entry: git secrets --pre_commit_hook
        language: system
        pass_filenames: false

  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.4.0
    hooks:
      - id: check-added-large-files
        args: ['--maxkb=1000']
      - id: check-merge-conflict
      - id: end-of-file-fixer
      - id: trailing-whitespace
```

Install pre-commit:

```bash
pip install pre-commit

# Install the git hook scripts
pre-commit install

# (optional) run against all files
pre-commit run --all-files
```

## Scheduled Scanning

Add to GitHub Actions `.github/workflows/secrets-scan.yml`:

```yaml
name: Secrets Scanning

on:
  push:
    branches: [main, develop]
  pull_request:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM

jobs:
  secrets-scan:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Fetch full history for scanning

      - name: TruffleHog Scan
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: main
          head: HEAD
          extra_args: --only-verified

      - name: Detect Secrets
        run: |
          pip install detect-secrets
          detect-secrets scan --baseline .secrets.baseline --all-files
          detect-secrets audit .secrets.baseline

      - name: OWASP Secret Detection
        uses: abdulrahman305/secrets-detection-action@v1
        with:
          path: ./
          verbose: true
```

## What Counts as a Secret?

Secrets include:

- ✗ Database passwords
- ✗ API keys (OpenAI, Stripe, etc.)
- ✗ Private encryption keys
- ✗ OAuth tokens
- ✗ SSH private keys
- ✗ JWT signing keys
- ✗ Vault tokens
- ✗ AWS credentials
- ✗ Redis passwords
- ✗ Webhook URLs with tokens

Safe to commit:

- ✓ API endpoint URLs (without keys)
- ✓ Configuration values
- ✓ Public information
- ✓ Example values marked as examples

## Emergency Secret Exposure Protocol

If a secret is exposed:

1. **Immediate Actions**
   - Invalidate the secret immediately
   - Rotate in Vault/AWS Secrets Manager
   - Update all services

2. **Investigation**
   - Determine what was exposed
   - Check if it was used to access systems
   - Review audit logs

3. **Remediation**
   - Remove from git history (BFG or git-filter-repo)
   - Force push with caution
   - Notify team members
   - Update documentation

4. **Prevention**
   - Add to pre-commit hooks
   - Improve secrets management
   - Implement automated scanning

## References

- [git-secrets Documentation](https://github.com/awslabs/git-secrets)
- [TruffleHog Documentation](https://github.com/trufflesecurity/trufflehog)
- [detect-secrets Documentation](https://github.com/Yelp/detect-secrets)
- [OWASP Secret Detection](https://github.com/abdulrahman305/secrets-detection-action)
- [GitHub Secret Scanning](https://docs.github.com/en/code-security/secret-scanning)
- [GitLab Secret Detection](https://docs.gitlab.com/ee/user/application_security/secret_detection/)
