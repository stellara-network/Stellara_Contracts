# Vault Client Implementation for Node.js/NestJS

## Overview

This guide shows how to integrate HashiCorp Vault and AWS Secrets Manager into the NestJS backend.

## Installation

### Dependencies

```bash
cd Backend
npm install node-vault aws-sdk dotenv
npm install --save-dev @types/node-vault
```

### package.json

Add to dependencies:

```json
{
  "dependencies": {
    "node-vault": "^3.6.0",
    "aws-sdk": "^2.1500.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/node-vault": "^3.6.1"
  }
}
```

## Vault Service Implementation

Create `src/config/vault.service.ts`:

```typescript
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as VaultClient from 'node-vault';
import * as AWS from 'aws-sdk';
import * as fs from 'fs';
import * as path from 'path';

interface VaultConfig {
  endpoint: string;
  token: string;
  namespace?: string;
}

interface SecretCache {
  [key: string]: any;
  expiresAt: number;
}

@Injectable()
export class VaultService implements OnModuleInit {
  private logger = new Logger('VaultService');
  private vaultClient: VaultClient.default;
  private secretsManager: AWS.SecretsManager;
  private useVault: boolean;
  private useAWSSecretsManager: boolean;
  private secretsCache: Map<string, SecretCache> = new Map();
  private cacheExpiry = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.useVault = process.env.VAULT_ENABLED === 'true';
    this.useAWSSecretsManager = process.env.AWS_SECRETS_MANAGER_ENABLED === 'true';

    if (this.useVault) {
      this.initializeVaultClient();
    }

    if (this.useAWSSecretsManager) {
      this.initializeAWSSecretsManager();
    }
  }

  private initializeVaultClient() {
    const vaultConfig: VaultConfig = {
      endpoint: process.env.VAULT_ADDR || 'http://localhost:8200',
      token: process.env.VAULT_TOKEN,
      namespace: process.env.VAULT_NAMESPACE || 'kv',
    };

    if (!vaultConfig.token) {
      throw new Error('VAULT_TOKEN environment variable is required');
    }

    this.vaultClient = new VaultClient.default({
      endpoint: vaultConfig.endpoint,
      token: vaultConfig.token,
      namespace: vaultConfig.namespace,
      apiVersion: 'v1',
      requestOptions: {
        timeout: 5000,
      },
    });

    this.logger.log(`Vault client initialized at ${vaultConfig.endpoint}`);
  }

  private initializeAWSSecretsManager() {
    this.secretsManager = new AWS.SecretsManager({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    this.logger.log('AWS Secrets Manager initialized');
  }

  async onModuleInit() {
    // Test connection to vault/secrets manager
    if (this.useVault) {
      try {
        await this.vaultClient.health();
        this.logger.log('Successfully connected to Vault');
      } catch (error) {
        this.logger.error(
          `Failed to connect to Vault: ${error.message}. Falling back to .env.local`,
        );
        this.useVault = false;
      }
    }

    if (this.useAWSSecretsManager) {
      try {
        await this.secretsManager.describeSecret({ SecretId: 'health-check' }).promise();
      } catch (error) {
        if (error.code !== 'ResourceNotFoundException') {
          this.logger.warn(
            `AWS Secrets Manager connection issue: ${error.message}`,
          );
        }
      }
    }
  }

  /**
   * Get secret from Vault or AWS Secrets Manager with caching
   */
  async getSecret(secretPath: string): Promise<any> {
    // Check cache first
    const cached = this.secretsCache.get(secretPath);
    if (cached && cached.expiresAt > Date.now()) {
      this.logger.debug(`Returning cached secret: ${secretPath}`);
      return cached;
    }

    let secret: any;

    if (this.useVault) {
      try {
        secret = await this.getSecretFromVault(secretPath);
      } catch (error) {
        this.logger.warn(
          `Failed to get secret from Vault: ${error.message}`,
        );
        secret = await this.getSecretFromEnv(secretPath);
      }
    } else if (this.useAWSSecretsManager) {
      try {
        secret = await this.getSecretFromAWSSecretsManager(secretPath);
      } catch (error) {
        this.logger.warn(
          `Failed to get secret from AWS Secrets Manager: ${error.message}`,
        );
        secret = await this.getSecretFromEnv(secretPath);
      }
    } else {
      secret = await this.getSecretFromEnv(secretPath);
    }

    // Cache the secret
    this.secretsCache.set(secretPath, {
      ...secret,
      expiresAt: Date.now() + this.cacheExpiry,
    });

    return secret;
  }

  /**
   * Get secret from Vault (KV v2)
   */
  private async getSecretFromVault(secretPath: string): Promise<any> {
    try {
      // Path format: kv/stellara/database/postgres -> kv/data/stellara/database/postgres
      const vaultPath = secretPath.startsWith('kv/')
        ? secretPath
        : `kv/${secretPath}`;

      const response = await this.vaultClient.read(vaultPath);
      return response.data.data;
    } catch (error) {
      this.logger.error(`Error reading from Vault (${secretPath}): ${error.message}`);
      throw error;
    }
  }

  /**
   * Get secret from AWS Secrets Manager
   */
  private async getSecretFromAWSSecretsManager(
    secretPath: string,
  ): Promise<any> {
    try {
      const response = await this.secretsManager
        .getSecretValue({ SecretId: secretPath })
        .promise();

      if ('SecretString' in response) {
        try {
          return JSON.parse(response.SecretString);
        } catch {
          return { value: response.SecretString };
        }
      }

      if ('SecretBinary' in response) {
        return Buffer.from(response.SecretBinary as string, 'base64');
      }

      throw new Error('No secret value found');
    } catch (error) {
      this.logger.error(
        `Error reading from AWS Secrets Manager (${secretPath}): ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Fallback: Get secret from .env.local or .env
   */
  private async getSecretFromEnv(secretPath: string): Promise<any> {
    this.logger.log(`Attempting to load secret from environment: ${secretPath}`);

    // Load .env.local first (higher priority)
    const envLocalPath = path.join(process.cwd(), '.env.local');
    if (fs.existsSync(envLocalPath)) {
      require('dotenv').config({ path: envLocalPath });
    } else {
      // Fall back to .env
      require('dotenv').config();
    }

    // Map secret paths to environment variable names
    const envVarMap: { [key: string]: string[] } = {
      'kv/stellara/database/postgres': [
        'DB_HOST',
        'DB_PORT',
        'DB_USERNAME',
        'DB_PASSWORD',
        'DB_DATABASE',
      ],
      'kv/stellara/auth/jwt': ['JWT_SECRET'],
      'kv/stellara/redis/cache': ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'],
      'kv/stellara/external/stellar': ['STELLAR_RPC_URL', 'STELLAR_NETWORK_PASSPHRASE'],
      'kv/stellara/external/llm': ['LLM_API_KEY', 'LLM_BASE_URL'],
    };

    const envVars = envVarMap[secretPath] || [];
    const secret: any = {};

    for (const envVar of envVars) {
      const value = process.env[envVar];
      if (value) {
        // Convert env var names to camelCase keys
        const key = envVar
          .toLowerCase()
          .split('_')
          .reduce((acc, word) => acc + word.charAt(0).toUpperCase() + word.slice(1));
        secret[key] = value;
      }
    }

    if (Object.keys(secret).length === 0) {
      throw new Error(`No environment variables found for ${secretPath}`);
    }

    return secret;
  }

  /**
   * Clear cache (useful for testing or manual secret rotation)
   */
  clearCache(secretPath?: string) {
    if (secretPath) {
      this.secretsCache.delete(secretPath);
    } else {
      this.secretsCache.clear();
    }
    this.logger.log(
      `Cache cleared for ${secretPath || 'all secrets'}`,
    );
  }

  /**
   * Health check method
   */
  async health(): Promise<{ vault: boolean; aws: boolean; env: boolean }> {
    const health = {
      vault: false,
      aws: false,
      env: true, // Always available as fallback
    };

    if (this.useVault) {
      try {
        await this.vaultClient.health();
        health.vault = true;
      } catch (error) {
        this.logger.error(`Vault health check failed: ${error.message}`);
      }
    }

    if (this.useAWSSecretsManager) {
      try {
        await this.secretsManager.describeSecret().promise();
        health.aws = true;
      } catch (error) {
        if (error.code !== 'InvalidParameterException') {
          this.logger.error(`AWS Secrets Manager health check failed: ${error.message}`);
        }
      }
    }

    return health;
  }
}
```

## Configuration Service Integration

Create `src/config/config.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { VaultService } from './vault.service';

@Injectable()
export class ConfigService {
  constructor(private vaultService: VaultService) {}

  async getDatabaseConfig() {
    const dbSecret = await this.vaultService.getSecret(
      'kv/stellara/database/postgres',
    );

    return {
      type: 'postgres',
      host: dbSecret.host || process.env.DB_HOST || 'localhost',
      port: parseInt(dbSecret.port || process.env.DB_PORT || '5432'),
      username: dbSecret.username || process.env.DB_USERNAME || 'postgres',
      password: dbSecret.password || process.env.DB_PASSWORD || 'password',
      database: dbSecret.database || process.env.DB_DATABASE || 'stellara_db',
    };
  }

  async getJwtConfig() {
    const jwtSecret = await this.vaultService.getSecret('kv/stellara/auth/jwt');

    return {
      secret: jwtSecret.secret || process.env.JWT_SECRET,
      accessExpiration: process.env.JWT_ACCESS_EXPIRATION || '15m',
      refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
    };
  }

  async getRedisConfig() {
    const redisSecret = await this.vaultService.getSecret(
      'kv/stellara/redis/cache',
    );

    return {
      host: redisSecret.host || process.env.REDIS_HOST || 'localhost',
      port: parseInt(redisSecret.port || process.env.REDIS_PORT || '6379'),
      password: redisSecret.password || process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_QUEUE_DB || '1'),
    };
  }

  async getStellarConfig() {
    const stellarSecret = await this.vaultService.getSecret(
      'kv/stellara/external/stellar',
    );

    return {
      rpcUrl: stellarSecret.rpcUrl || process.env.STELLAR_RPC_URL,
      networkPassphrase:
        stellarSecret.networkPassphrase ||
        process.env.STELLAR_NETWORK_PASSPHRASE,
    };
  }

  async getLlmConfig() {
    const llmSecret = await this.vaultService.getSecret(
      'kv/stellara/external/llm',
    );

    return {
      apiKey: llmSecret.apiKey || process.env.LLM_API_KEY,
      baseUrl: llmSecret.baseUrl || process.env.LLM_BASE_URL,
    };
  }
}
```

## NestJS Module Setup

Create `src/config/config.module.ts`:

```typescript
import { Module, Global } from '@nestjs/common';
import { VaultService } from './vault.service';
import { ConfigService } from './config.service';

@Global()
@Module({
  providers: [VaultService, ConfigService],
  exports: [VaultService, ConfigService],
})
export class ConfigModule {}
```

## Updated App Module

Update `src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisModule } from './redis/redis.module';
import { VoiceModule } from './voice/voice.module';
import { DatabaseModule } from './database/database.module';
import { StellarMonitorModule } from './stellar-monitor/stellar-monitor.module';
import { WorkflowModule } from './workflow/workflow.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule as VaultConfigModule } from './config/config.module';
import { ConfigService as VaultConfigService } from './config/config.service';
import { VaultService } from './config/vault.service';

// ... entity imports ...

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    VaultConfigModule, // Custom Vault config module
    TypeOrmModule.forRootAsync({
      imports: [VaultConfigModule],
      useFactory: async (vaultConfigService: VaultConfigService) => {
        const dbConfig = await vaultConfigService.getDatabaseConfig();
        return {
          ...dbConfig,
          entities: [
            // ... your entities ...
          ],
          synchronize: process.env.NODE_ENV === 'development',
          logging: process.env.NODE_ENV === 'development',
        };
      },
      inject: [VaultConfigService],
    }),
    DatabaseModule,
    RedisModule,
    AuthModule,
    VoiceModule,
    StellarMonitorModule,
    WorkflowModule,
    QueueModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

## Health Check Endpoint

Add to `src/app.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { VaultService } from './config/vault.service';

@Controller()
export class AppController {
  constructor(
    private appService: AppService,
    private vaultService: VaultService,
  ) {}

  @Get('health')
  async health() {
    const vaultHealth = await this.vaultService.health();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      secrets: vaultHealth,
    };
  }
}
```

## Environment Variables

Create `.env` for development (commit to repo - no secrets):

```dotenv
# Vault Configuration
VAULT_ENABLED=true
VAULT_ADDR=http://localhost:8200
VAULT_NAMESPACE=kv
VAULT_TOKEN=devroot  # Only for development - use AppRole in production

# AWS Secrets Manager (optional)
AWS_SECRETS_MANAGER_ENABLED=false
AWS_REGION=us-east-1

# Application
NODE_ENV=development
PORT=3000

# Stellar
STELLAR_RPC_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Fallback values (used if Vault/AWS unavailable)
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=password
DB_DATABASE=stellara_db
JWT_SECRET=dev-secret-key
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

Create `.env.local` locally (never commit - add to .gitignore):

```dotenv
# Local development overrides
DB_PASSWORD=your-local-dev-password
JWT_SECRET=your-local-dev-jwt-secret
REDIS_PASSWORD=your-local-redis-password
```

Add to `.gitignore`:

```
.env.local
.env.local.backup
.env.*.local
```

## Usage in Services

Example usage in any NestJS service:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from './config/config.service';

@Injectable()
export class YourService {
  constructor(private configService: ConfigService) {}

  async initialize() {
    const jwtConfig = await this.configService.getJwtConfig();
    const redisConfig = await this.configService.getRedisConfig();
    
    console.log('JWT Secret loaded from vault');
    console.log('Redis config:', redisConfig);
  }
}
```

## Testing

Create `test/vault.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { VaultService } from '../src/config/vault.service';
import { ConfigService } from '../src/config/config.service';

describe('VaultService', () => {
  let vaultService: VaultService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VaultService, ConfigService],
    }).compile();

    vaultService = module.get<VaultService>(VaultService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should load database config', async () => {
    const dbConfig = await configService.getDatabaseConfig();
    expect(dbConfig).toHaveProperty('host');
    expect(dbConfig).toHaveProperty('password');
  });

  it('should cache secrets', async () => {
    const secret1 = await vaultService.getSecret('kv/stellara/auth/jwt');
    const secret2 = await vaultService.getSecret('kv/stellara/auth/jwt');
    
    expect(secret1).toEqual(secret2);
  });

  it('should clear cache', () => {
    vaultService.clearCache('kv/stellara/auth/jwt');
    // Cache should be cleared
  });

  it('should report health status', async () => {
    const health = await vaultService.health();
    expect(health).toHaveProperty('vault');
    expect(health).toHaveProperty('aws');
    expect(health).toHaveProperty('env');
  });
});
```

## Troubleshooting

### "VAULT_TOKEN is required"

Ensure the environment variable is set:

```bash
export VAULT_TOKEN=devroot
export VAULT_ADDR=http://localhost:8200
```

### "Failed to connect to Vault"

Check that Vault server is running:

```bash
vault server -dev
# In another terminal:
curl http://localhost:8200/v1/sys/health
```

### Secrets not caching

Check logs and clear cache if needed:

```bash
vaultService.clearCache();
```

### AWS Credentials not found

Ensure AWS credentials are configured:

```bash
aws configure
# Or set environment variables:
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
```

## References

- [node-vault Documentation](https://github.com/nodevault/node-vault)
- [AWS SDK for JavaScript](https://docs.aws.amazon.com/sdk-for-javascript/)
- [NestJS Configuration](https://docs.nestjs.com/techniques/configuration)
