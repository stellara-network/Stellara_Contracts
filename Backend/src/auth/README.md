# Authentication Module

Comprehensive authentication system for Stellara with Freighter wallet integration, JWT session management, API token support, and Redis-based rate limiting.

## Features

- **Wallet-Based Authentication**: Freighter wallet signature verification using Ed25519
- **JWT Tokens**: Short-lived access tokens (15 minutes) with refresh tokens (7 days)
- **API Tokens**: Long-lived tokens for AI/worker services with role-based access
- **Rate Limiting**: Redis-based distributed rate limiting to prevent abuse
- **Token Rotation**: Automatic refresh token rotation for enhanced security
- **Account Binding**: Multiple wallet support per user account
- **Nonce-Based Challenge**: Prevents replay attacks

## Architecture

### Entities

1. **User** - Platform user accounts
2. **WalletBinding** - Stellar wallet associations
3. **LoginNonce** - Temporary authentication challenges
4. **RefreshToken** - Long-lived session tokens
5. **ApiToken** - Service authentication tokens

### Services

1. **NonceService** - Challenge generation and validation
2. **WalletService** - Signature verification and wallet management
3. **JwtAuthService** - JWT token lifecycle management
4. **ApiTokenService** - API token creation and validation
5. **RateLimitService** - Request throttling

### Guards

1. **JwtAuthGuard** - Protects routes requiring user authentication
2. **ApiTokenGuard** - Validates API tokens for service access
3. **RateLimitGuard** - Enforces rate limits per endpoint
4. **RolesGuard** - Role-based authorization

## API Endpoints

### Public Endpoints

#### POST /auth/nonce
Request a nonce for wallet authentication.

**Request:**
```json
{
  "publicKey": "GABC123..."
}
```

**Response:**
```json
{
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "expiresAt": "2024-01-23T12:05:00Z",
  "message": "Sign this message to authenticate with Stellara: 550e8400-e29b-41d4-a716-446655440000"
}
```

**Rate Limit:** 5 requests/minute per IP

#### POST /auth/wallet/login
Login with wallet signature.

**Request:**
```json
{
  "publicKey": "GABC123...",
  "signature": "base64-encoded-signature",
  "nonce": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "550e8400-e29b-41d4-a716-446655440001",
  "user": {
    "id": "user-uuid",
    "email": null,
    "username": null,
    "createdAt": "2024-01-23T12:00:00Z"
  }
}
```

**Rate Limit:** 5 requests/minute per IP

#### POST /auth/refresh
Refresh access token.

**Request:**
```json
{
  "refreshToken": "550e8400-e29b-41d4-a716-446655440001"
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "550e8400-e29b-41d4-a716-446655440002"
}
```

**Rate Limit:** 10 requests/minute per user

### Protected Endpoints (JWT Required)

#### GET /auth/me
Get current user information.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "id": "user-uuid",
  "email": null,
  "username": null,
  "isActive": true,
  "createdAt": "2024-01-23T12:00:00Z",
  "wallets": [
    {
      "id": "wallet-uuid",
      "publicKey": "GABC123...",
      "isPrimary": true,
      "lastUsed": "2024-01-23T12:30:00Z"
    }
  ]
}
```

#### POST /auth/logout
Revoke all refresh tokens.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "message": "Logged out successfully"
}
```

#### POST /auth/wallet/bind
Bind additional wallet to account.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request:**
```json
{
  "publicKey": "GXYZ789...",
  "signature": "base64-encoded-signature",
  "nonce": "550e8400-e29b-41d4-a716-446655440003"
}
```

**Response:**
```json
{
  "message": "Wallet bound successfully",
  "wallet": {
    "id": "wallet-uuid",
    "publicKey": "GXYZ789...",
    "isPrimary": false
  }
}
```

#### DELETE /auth/wallet/unbind
Unbind wallet from account.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request:**
```json
{
  "publicKey": "GXYZ789..."
}
```

**Response:**
```json
{
  "message": "Wallet unbound successfully"
}
```

### API Token Endpoints (JWT Required)

#### POST /auth/api-token
Create API token for services.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request:**
```json
{
  "name": "AI Service Token",
  "role": "ai-service",
  "expiresInDays": 90
}
```

**Response:**
```json
{
  "token": "stl_abc123...",
  "id": "token-uuid",
  "name": "AI Service Token",
  "role": "ai-service",
  "expiresAt": "2024-04-23T12:00:00Z",
  "warning": "Save this token securely. It will not be shown again."
}
```

#### GET /auth/api-token
List user's API tokens.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
[
  {
    "id": "token-uuid",
    "name": "AI Service Token",
    "role": "ai-service",
    "expiresAt": "2024-04-23T12:00:00Z",
    "revoked": false,
    "lastUsedAt": "2024-01-23T12:30:00Z",
    "createdAt": "2024-01-23T12:00:00Z"
  }
]
```

#### DELETE /auth/api-token/:id
Revoke API token.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "message": "API token revoked successfully"
}
```

## Frontend Integration (Freighter Wallet)

### Installation

```bash
npm install @stellar/freighter-api
```

### Example: Login Flow

```typescript
import { isConnected, getPublicKey, signMessage } from '@stellar/freighter-api';

async function loginWithFreighter() {
  // 1. Check if Freighter is available
  const connected = await isConnected();
  if (!connected) {
    throw new Error('Freighter wallet not installed');
  }

  // 2. Get public key
  const publicKey = await getPublicKey();

  // 3. Request nonce from backend
  const nonceResponse = await fetch('https://api.stellara.com/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  const { nonce, message } = await nonceResponse.json();

  // 4. Sign message with Freighter
  const signedMessage = await signMessage(message);

  // 5. Login with signature
  const loginResponse = await fetch('https://api.stellara.com/auth/wallet/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      signature: signedMessage,
      nonce,
    }),
  });

  const { accessToken, refreshToken, user } = await loginResponse.json();

  // 6. Store tokens
  localStorage.setItem('accessToken', accessToken);
  localStorage.setItem('refreshToken', refreshToken);

  return user;
}
```

### Example: API Request with Token

```typescript
async function makeAuthenticatedRequest(endpoint: string) {
  const accessToken = localStorage.getItem('accessToken');

  const response = await fetch(`https://api.stellara.com${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (response.status === 401) {
    // Token expired, refresh it
    const newToken = await refreshAccessToken();
    // Retry request with new token
    return makeAuthenticatedRequest(endpoint);
  }

  return response.json();
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('refreshToken');

  const response = await fetch('https://api.stellara.com/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  const { accessToken, refreshToken: newRefreshToken } = await response.json();

  localStorage.setItem('accessToken', accessToken);
  localStorage.setItem('refreshToken', newRefreshToken);

  return accessToken;
}
```

## Configuration

Add the following environment variables to your `.env` file:

```env
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# Rate Limiting
RATE_LIMIT_LOGIN=5
RATE_LIMIT_REFRESH=10
RATE_LIMIT_API=100
RATE_LIMIT_WINDOW=60

# API Token
API_TOKEN_DEFAULT_EXPIRY_DAYS=90

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=password
DB_NAME=stellara_db

# Redis
REDIS_URL=redis://localhost:6379
```

## Security Best Practices

1. **JWT Secret**: Use a strong, random secret in production
2. **HTTPS Only**: Always use HTTPS in production
3. **Token Storage**: Store refresh tokens securely (HTTP-only cookies recommended)
4. **Rate Limiting**: Adjust rate limits based on your use case
5. **Token Rotation**: Refresh tokens are automatically rotated on use
6. **Nonce Expiration**: Nonces expire after 5 minutes
7. **API Token Hashing**: API tokens are bcrypt-hashed before storage

## Testing

### Unit Tests

```bash
npm run test -- auth
```

### Integration Tests

```bash
npm run test:e2e -- auth.integration
```

### Test Coverage

```bash
npm run test:cov
```

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /auth/nonce | 5 requests | 60 seconds |
| POST /auth/wallet/login | 5 requests | 60 seconds |
| POST /auth/refresh | 10 requests | 60 seconds |
| API endpoints | 100 requests | 60 seconds |

## Error Codes

| Status | Description |
|--------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Invalid token or signature |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource not found |
| 409 | Conflict - Wallet already bound |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## Database Migrations

Generate migration:
```bash
npm run migration:generate -- src/database/migrations/CreateAuthTables
```

Run migrations:
```bash
npm run migration:run
```

Revert migration:
```bash
npm run migration:revert
```

## API Token Roles

- **ai-service**: For AI/LLM services
- **worker**: For background job workers
- **admin**: For administrative services

## Maintenance

### Cleanup Expired Nonces

Nonces are automatically cleaned up every hour via scheduled task.

### Revoke All User Tokens

```typescript
await jwtAuthService.revokeAllUserRefreshTokens(userId);
await apiTokenService.revokeAllUserApiTokens(userId);
```

## Support

For issues or questions, please refer to the main project documentation or create an issue in the repository.
