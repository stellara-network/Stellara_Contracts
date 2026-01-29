# CI/CD Secrets Integration

## Overview

This document explains how to integrate secrets management into your CI/CD pipelines (GitHub Actions, GitLab CI, etc.) without storing secrets in repository files.

## GitHub Actions Integration

### Setup AWS Credentials in GitHub

1. Go to your GitHub repository → Settings → Secrets and variables → Actions
2. Create repository secrets:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `VAULT_TOKEN` (if using HashiCorp Vault)
   - `VAULT_ADDR`

### GitHub Actions Workflow (Using AWS Secrets Manager)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Backend

on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main]

env:
  AWS_REGION: us-east-1

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          cache-dependency-path: Backend/package-lock.json

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/GitHubActionsRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Load Secrets from AWS Secrets Manager
        run: |
          # Database secrets
          DB_SECRET=$(aws secretsmanager get-secret-value \
            --secret-id /stellara/database/postgres \
            --region ${{ env.AWS_REGION }} \
            --query SecretString --output text)
          
          export DB_HOST=$(echo $DB_SECRET | jq -r '.host')
          export DB_PORT=$(echo $DB_SECRET | jq -r '.port')
          export DB_USERNAME=$(echo $DB_SECRET | jq -r '.username')
          export DB_PASSWORD=$(echo $DB_SECRET | jq -r '.password')
          export DB_DATABASE=$(echo $DB_SECRET | jq -r '.database')
          
          # JWT secrets
          JWT_SECRET=$(aws secretsmanager get-secret-value \
            --secret-id /stellara/jwt/secret \
            --region ${{ env.AWS_REGION }} \
            --query SecretString --output text)
          export JWT_SECRET=$JWT_SECRET
          
          # Save to GitHub Actions environment
          {
            echo "DB_HOST=$DB_HOST"
            echo "DB_PORT=$DB_PORT"
            echo "DB_USERNAME=$DB_USERNAME"
            echo "DB_PASSWORD=$DB_PASSWORD"
            echo "DB_DATABASE=$DB_DATABASE"
            echo "JWT_SECRET=$JWT_SECRET"
          } >> $GITHUB_ENV

      - name: Install Dependencies
        run: |
          cd Backend
          npm ci

      - name: Run Tests
        run: |
          cd Backend
          npm run test

      - name: Build
        run: |
          cd Backend
          npm run build

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/GitHubActionsDeployRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Load Secrets
        id: secrets
        run: |
          # Load all secrets into outputs
          DB_SECRET=$(aws secretsmanager get-secret-value \
            --secret-id /stellara/database/postgres \
            --region ${{ env.AWS_REGION }} \
            --query SecretString --output text)
          
          echo "db_host=$(echo $DB_SECRET | jq -r '.host')" >> $GITHUB_OUTPUT
          echo "db_password=$(echo $DB_SECRET | jq -r '.password')" >> $GITHUB_OUTPUT

      - name: Deploy to ECS
        run: |
          # Update ECS task definition with secrets from Secrets Manager ARN
          aws ecs update-service \
            --cluster stellara-prod \
            --service backend \
            --force-new-deployment \
            --region ${{ env.AWS_REGION }}

      - name: Deploy to Lambda Functions
        run: |
          # For Lambda: secrets are injected via environment variables
          # pointing to Secrets Manager ARNs
          aws lambda update-function-configuration \
            --function-name stellara-processor \
            --environment Variables="{
              VAULT_ENABLED=false,
              AWS_SECRETS_MANAGER_ENABLED=true,
              AWS_REGION=${{ env.AWS_REGION }},
              DB_SECRET_ARN=arn:aws:secretsmanager:${{ env.AWS_REGION }}:ACCOUNT:secret:/stellara/database/postgres,
              JWT_SECRET_ARN=arn:aws:secretsmanager:${{ env.AWS_REGION }}:ACCOUNT:secret:/stellara/jwt/secret
            }" \
            --region ${{ env.AWS_REGION }}
```

### GitHub Actions Workflow (Using Vault)

Create `.github/workflows/deploy-vault.yml`:

```yaml
name: Deploy Backend (Vault)

on:
  push:
    branches: [main, staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'

      - name: Authenticate with Vault
        run: |
          # Use AppRole authentication for CI/CD
          ROLE_ID=${{ secrets.VAULT_ROLE_ID }}
          SECRET_ID=${{ secrets.VAULT_SECRET_ID }}
          VAULT_ADDR=${{ secrets.VAULT_ADDR }}
          
          # Request token from AppRole
          TOKEN_RESPONSE=$(curl -s -X POST \
            -d '{"role_id":"'$ROLE_ID'","secret_id":"'$SECRET_ID'"}' \
            "$VAULT_ADDR/v1/auth/approle/login")
          
          export VAULT_TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.auth.client_token')
          echo "VAULT_TOKEN=$VAULT_TOKEN" >> $GITHUB_ENV
          echo "VAULT_ADDR=$VAULT_ADDR" >> $GITHUB_ENV

      - name: Load Secrets from Vault
        run: |
          # Install vault CLI
          curl -s https://releases.hashicorp.com/vault/1.15.0/vault_1.15.0_linux_amd64.zip -o vault.zip
          unzip -q vault.zip && rm vault.zip
          
          # Load secrets
          DB_CONFIG=$(./vault kv get -format=json kv/stellara/database/postgres | jq '.data.data')
          JWT_SECRET=$(./vault kv get -field=secret kv/stellara/auth/jwt)
          
          echo "DB_HOST=$(echo $DB_CONFIG | jq -r '.host')" >> $GITHUB_ENV
          echo "DB_PASSWORD=$(echo $DB_CONFIG | jq -r '.password')" >> $GITHUB_ENV
          echo "JWT_SECRET=$JWT_SECRET" >> $GITHUB_ENV

      - name: Build and Deploy
        run: |
          cd Backend
          npm ci
          npm run build
          # Deploy logic here

      - name: Revoke Vault Token
        if: always()
        run: |
          ./vault token revoke -self
```

## GitLab CI Integration

Create `.gitlab-ci.yml`:

```yaml
stages:
  - test
  - build
  - deploy

variables:
  AWS_DEFAULT_REGION: us-east-1

test_backend:
  stage: test
  image: node:18-alpine
  before_script:
    - cd Backend
    - npm ci
    - |
      # Load secrets from AWS Secrets Manager
      apk add --no-cache aws-cli jq
      DB_SECRET=$(aws secretsmanager get-secret-value \
        --secret-id /stellara/database/postgres \
        --query SecretString --output text)
      export DB_HOST=$(echo $DB_SECRET | jq -r '.host')
      export DB_PASSWORD=$(echo $DB_SECRET | jq -r '.password')
      export JWT_SECRET=$(aws secretsmanager get-secret-value \
        --secret-id /stellara/jwt/secret \
        --query SecretString --output text)
  script:
    - npm run test
    - npm run build
  artifacts:
    paths:
      - Backend/dist/
  only:
    - main
    - staging
  variables:
    AWS_ACCESS_KEY_ID: $AWS_ACCESS_KEY_ID  # Set in GitLab CI/CD variables
    AWS_SECRET_ACCESS_KEY: $AWS_SECRET_ACCESS_KEY

build_backend:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA Backend/
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
  only:
    - main

deploy_production:
  stage: deploy
  image: amazon/aws-cli:latest
  before_script:
    - apk add --no-cache jq
  script:
    - |
      # Update ECS service to use new image
      aws ecs update-service \
        --cluster stellara-prod \
        --service backend \
        --force-new-deployment
  only:
    - main
  variables:
    AWS_DEFAULT_REGION: us-east-1
```

## Environment Variables in CI/CD

### GitHub Actions Secrets

Set these in repository settings:

```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
VAULT_ADDR
VAULT_ROLE_ID (for AppRole auth)
VAULT_SECRET_ID (for AppRole auth)
DOCKER_USERNAME
DOCKER_PASSWORD
```

### GitLab CI Variables

Set in GitLab CI/CD Variables:

```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
CI_REGISTRY_USER
CI_REGISTRY_PASSWORD
VAULT_ADDR
VAULT_ROLE_ID
VAULT_SECRET_ID
```

## Docker Image Secrets

For Docker builds that need secrets:

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Use BuildKit secrets
RUN --mount=type=secret,id=npm_token \
    npm install --registry=https://registry.npmjs.org

# Copy source and build
COPY Backend/ .
RUN npm run build

# Runtime: secrets come from environment variables (Secrets Manager)
CMD ["node", "dist/main.js"]
```

Build with:

```bash
docker build \
  --secret npm_token=$NPM_TOKEN \
  --tag stellara-backend:latest \
  .
```

## ECS Task Definition with Secrets

Create `Backend/ecs-task-definition.json`:

```json
{
  "family": "stellara-backend",
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/ecsTaskRole",
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "backend",
      "image": "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/stellara-backend:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        },
        {
          "name": "AWS_SECRETS_MANAGER_ENABLED",
          "value": "true"
        },
        {
          "name": "AWS_REGION",
          "value": "us-east-1"
        }
      ],
      "secrets": [
        {
          "name": "DB_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:/stellara/database/postgres:password::"
        },
        {
          "name": "JWT_SECRET",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:/stellara/jwt/secret:SecretString::"
        },
        {
          "name": "REDIS_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:/stellara/redis/cache:password::"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/stellara-backend",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512"
}
```

## Scanning for Secrets in CI/CD

Add secret scanning to your pipeline:

### GitLab Secret Detection

```yaml
secret_detection:
  stage: test
  image: node:18-alpine
  before_script:
    - npm install -g detect-secrets
  script:
    - detect-secrets scan --baseline .secrets.baseline
    - detect-secrets audit .secrets.baseline
  allow_failure: false
```

### GitHub Secret Scanning

Add to workflow:

```yaml
- name: Detect Secrets
  uses: trufflesecurity/trufflehog@main
  with:
    path: ./
    base: ${{ github.event.repository.default_branch }}
    head: HEAD
    extra_args: --only-verified
```

### Preventing Secrets in Git

Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.4.0
    hooks:
      - id: detect-secrets
        args: ['--baseline', '.secrets.baseline']
```

## Vault Authentication Methods

### AppRole (Recommended for CI/CD)

```bash
# Create AppRole for CI/CD
vault auth enable approle

# Create policy
vault policy write stellara-ci -<<EOF
path "kv/data/stellara/*" {
  capabilities = ["read", "list"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
EOF

# Create role
vault write auth/approle/role/stellara-ci \
  token_ttl=1h \
  token_max_ttl=4h \
  policies="stellara-ci"

# Get role ID and secret ID
ROLE_ID=$(vault read -field=role_id auth/approle/role/stellara-ci/role-id)
SECRET_ID=$(vault write -field=secret_id -f auth/approle/role/stellara-ci/secret-id)

echo "ROLE_ID=$ROLE_ID"
echo "SECRET_ID=$SECRET_ID"
```

Store `ROLE_ID` and `SECRET_ID` as GitHub/GitLab secrets.

### Kubernetes Authentication

For Kubernetes deployments:

```bash
# Enable Kubernetes auth
vault auth enable kubernetes

# Configure with cluster details
vault write auth/kubernetes/config \
  kubernetes_host="https://$KUBERNETES_HOST:443" \
  kubernetes_ca_cert=@ca.crt \
  token_reviewer_jwt=@token

# Create role for app
vault write auth/kubernetes/role/stellara-app \
  bound_service_account_names=stellara-backend \
  bound_service_account_namespaces=production \
  policies=stellara-policy \
  ttl=24h
```

## Best Practices

1. **Never commit secrets**: Use `.gitignore` and `.gitlab-ci.yml` to exclude `.env` files
2. **Use IAM roles**: Prefer IAM roles over access keys in cloud environments
3. **Short-lived credentials**: Use temporary credentials with minimal TTL
4. **Audit all access**: Log all secret retrievals
5. **Rotation policies**: Implement automated secret rotation
6. **Least privilege**: Grant only necessary permissions
7. **Separate staging/prod secrets**: Different credentials for each environment
8. **Monitor secret access**: Alert on unusual patterns

## References

- [AWS Secrets Manager Documentation](https://docs.aws.amazon.com/secretsmanager/)
- [HashiCorp Vault CI/CD Guide](https://www.vaultproject.io/use-cases/ci-cd-secrets)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [GitLab CI/CD Variables](https://docs.gitlab.com/ee/ci/variables/)
- [OWASP CI/CD Security](https://owasp.org/www-community/CICD_SECURITY)
