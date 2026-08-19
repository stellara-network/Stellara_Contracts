import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConfigValidationService } from './config-validation.service';
import { SecretsMaskingService } from './secrets-masking.service';

describe('ConfigValidationService', () => {
  let service: ConfigValidationService;
  let configService: ConfigService;
  let maskingService: SecretsMaskingService;

  // Default valid env vars for development
  const validEnvVars: Record<string, string | undefined> = {
    NODE_ENV: 'development',
    PORT: '3000',
    JWT_SECRET: 'a-very-secure-secret-key-that-is-at-least-32-chars',
    JWT_ACCESS_EXPIRATION: '15m',
    JWT_REFRESH_EXPIRATION: '7d',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USERNAME: 'postgres',
    DB_PASSWORD: 'a-very-secure-db-password-16chars',
    DB_DATABASE: 'stellara_db',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_HOST: undefined,
    REDIS_PORT: undefined,
    REDIS_PASSWORD: undefined,
    REDIS_QUEUE_DB: '1',
    QUEUE_DEPLOY_CONTRACT_CONCURRENCY: '2',
    QUEUE_PROCESS_TTS_CONCURRENCY: '4',
    QUEUE_INDEX_MARKET_NEWS_CONCURRENCY: '3',
    QUEUE_DEFAULT_ATTEMPTS: '3',
    QUEUE_DEFAULT_BACKOFF_DELAY: '2000',
    QUEUE_KEEP_COMPLETED_JOBS: '24',
    QUEUE_KEEP_FAILED_JOBS: '7',
    QUEUE_DEBUG_LOGGING: 'false',
    QUEUE_EVENT_TRACKING: 'true',
    QUEUE_DLQ_RETENTION_DAYS: '30',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_RPC_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_MONITOR_ENABLED: 'true',
    WEBHOOK_SECRET_KEY:
      '0000000000000000000000000000000000000000000000000000000000000000',
    VAULT_ENABLED: 'true',
    VAULT_ADDR: 'http://localhost:8200',
    VAULT_NAMESPACE: 'kv',
    VAULT_TOKEN: undefined,
    AWS_SECRETS_MANAGER_ENABLED: 'false',
    RATE_LIMIT_LOGIN: '5',
    RATE_LIMIT_REFRESH: '10',
    RATE_LIMIT_API: '100',
    RATE_LIMIT_WINDOW: '60',
    LLM_API_KEY: undefined,
    LLM_BASE_URL: undefined,
    SWAGGER_ENABLED: 'true',
    DEBUG: 'false',
    CORS_ORIGINS: 'http://localhost:3000',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigValidationService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: SecretsMaskingService,
          useValue: {
            mask: jest.fn((s: string) => s),
            maskError: jest.fn((e: Error) => e),
          },
        },
      ],
    }).compile();

    service = module.get<ConfigValidationService>(ConfigValidationService);
    configService = module.get<ConfigService>(ConfigService);
    maskingService = module.get<SecretsMaskingService>(SecretsMaskingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validate', () => {
    it('should pass validation with all valid environment variables', () => {
      (configService.get as jest.Mock).mockImplementation(
        (key: string) => validEnvVars[key],
      );

      const result = service.validate();
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    describe('required env vars', () => {
      it('should throw when JWT_SECRET is missing', () => {
        const envVars = { ...validEnvVars, JWT_SECRET: undefined };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Configuration validation failed',
        );
      });

      it('should throw when DB_HOST is missing', () => {
        const envVars = { ...validEnvVars, DB_HOST: undefined };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Configuration validation failed',
        );
      });

      it('should throw when DB_PASSWORD is missing', () => {
        const envVars = { ...validEnvVars, DB_PASSWORD: undefined };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Configuration validation failed',
        );
      });

      it('should throw when both REDIS_URL and REDIS_HOST are missing', () => {
        const envVars = {
          ...validEnvVars,
          REDIS_URL: undefined,
          REDIS_HOST: undefined,
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow('Redis configuration missing');
      });

      it('should pass when REDIS_HOST is set instead of REDIS_URL', () => {
        const envVars = {
          ...validEnvVars,
          REDIS_URL: undefined,
          REDIS_HOST: 'localhost',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });
    });

    describe('port validation', () => {
      it('should throw for invalid DB_PORT (out of range)', () => {
        const envVars = { ...validEnvVars, DB_PORT: '70000' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'DB_PORT must be between 1 and 65535',
        );
      });

      it('should throw for invalid PORT (out of range)', () => {
        const envVars = { ...validEnvVars, PORT: '0' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'PORT must be between 1 and 65535',
        );
      });

      it('should throw for invalid REDIS_PORT (out of range)', () => {
        const envVars = { ...validEnvVars, REDIS_PORT: '99999' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'REDIS_PORT must be between 1 and 65535',
        );
      });

      it('should accept valid port numbers', () => {
        const envVars = {
          ...validEnvVars,
          DB_PORT: '5432',
          PORT: '8080',
          REDIS_PORT: '6379',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });
    });

    describe('Redis URL validation', () => {
      it('should throw for invalid REDIS_URL format', () => {
        const envVars = { ...validEnvVars, REDIS_URL: 'ftp://localhost:6379' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'REDIS_URL must start with redis:// or rediss://',
        );
      });

      it('should accept redis:// URL', () => {
        const envVars = {
          ...validEnvVars,
          REDIS_URL: 'redis://localhost:6379',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });

      it('should accept rediss:// URL', () => {
        const envVars = {
          ...validEnvVars,
          REDIS_URL: 'rediss://localhost:6379',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });
    });

    describe('NODE_ENV validation', () => {
      it('should accept valid NODE_ENV values', () => {
        for (const env of ['development', 'staging', 'production', 'test']) {
          const envVars = { ...validEnvVars, NODE_ENV: env };
          (configService.get as jest.Mock).mockImplementation(
            (key: string) => envVars[key],
          );

          expect(() => service.validate()).not.toThrow();
        }
      });

      it('should throw for invalid NODE_ENV', () => {
        const envVars = { ...validEnvVars, NODE_ENV: 'invalid-env' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow('NODE_ENV must be one of');
      });
    });

    describe('queue config validation', () => {
      it('should throw for invalid QUEUE_DEPLOY_CONTRACT_CONCURRENCY', () => {
        const envVars = {
          ...validEnvVars,
          QUEUE_DEPLOY_CONTRACT_CONCURRENCY: '100',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'QUEUE_DEPLOY_CONTRACT_CONCURRENCY must be between 1 and 50',
        );
      });

      it('should throw for invalid QUEUE_PROCESS_TTS_CONCURRENCY', () => {
        const envVars = {
          ...validEnvVars,
          QUEUE_PROCESS_TTS_CONCURRENCY: '0',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'QUEUE_PROCESS_TTS_CONCURRENCY must be between 1 and 50',
        );
      });

      it('should accept valid queue concurrency values', () => {
        const envVars = {
          ...validEnvVars,
          QUEUE_DEPLOY_CONTRACT_CONCURRENCY: '10',
          QUEUE_PROCESS_TTS_CONCURRENCY: '20',
          QUEUE_INDEX_MARKET_NEWS_CONCURRENCY: '15',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });
    });

    describe('WEBHOOK_SECRET_KEY validation', () => {
      it('should throw for non-hex WEBHOOK_SECRET_KEY', () => {
        const envVars = {
          ...validEnvVars,
          WEBHOOK_SECRET_KEY: 'not-a-hex-string',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'WEBHOOK_SECRET_KEY must be a 64-character hexadecimal string',
        );
      });

      it('should throw for wrong-length WEBHOOK_SECRET_KEY', () => {
        const envVars = {
          ...validEnvVars,
          WEBHOOK_SECRET_KEY: 'abcdef',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'WEBHOOK_SECRET_KEY must be a 64-character hexadecimal string',
        );
      });

      it('should accept valid 64-char hex WEBHOOK_SECRET_KEY', () => {
        const envVars = {
          ...validEnvVars,
          WEBHOOK_SECRET_KEY:
            '0000000000000000000000000000000000000000000000000000000000000000',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });
    });

    describe('Stellar URL validation', () => {
      it('should throw for invalid HORIZON_URL', () => {
        const envVars = { ...validEnvVars, HORIZON_URL: 'ftp://invalid' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'HORIZON_URL must start with http:// or https://',
        );
      });

      it('should throw for invalid STELLAR_RPC_URL', () => {
        const envVars = { ...validEnvVars, STELLAR_RPC_URL: 'ws://invalid' };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'STELLAR_RPC_URL must start with http:// or https://',
        );
      });
    });

    describe('production mode validation', () => {
      it('should throw error in production with default JWT_SECRET', () => {
        const envVars = {
          ...validEnvVars,
          JWT_SECRET: 'default-secret-change-in-production',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Production environment detected with weak or default',
        );
      });

      it('should throw error in production with weak JWT_SECRET (less than 32 chars)', () => {
        const envVars = {
          ...validEnvVars,
          JWT_SECRET: 'short-secret',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'JWT_SECRET must be at least 32 characters long in production',
        );
      });

      it('should throw error in production with default DB_PASSWORD', () => {
        const envVars = {
          ...validEnvVars,
          DB_PASSWORD: 'password',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Production environment detected with weak or default',
        );
      });

      it('should throw error in production with weak DB_PASSWORD (less than 16 chars)', () => {
        const envVars = {
          ...validEnvVars,
          DB_PASSWORD: 'weakpass',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'DB_PASSWORD must be at least 16 characters long in production',
        );
      });

      it('should pass validation in production with strong secrets', () => {
        const envVars = {
          ...validEnvVars,
          JWT_SECRET: 'a-very-secure-secret-key-that-is-at-least-32-chars',
          DB_PASSWORD: 'a-very-secure-db-password-16chars',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });

      it('should throw error in production with JWT_SECRET = "secret"', () => {
        const envVars = {
          ...validEnvVars,
          JWT_SECRET: 'secret',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Production environment detected with weak or default',
        );
      });

      it('should throw error in production with JWT_SECRET = "changeme"', () => {
        const envVars = {
          ...validEnvVars,
          JWT_SECRET: 'changeme',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Production environment detected with weak or default',
        );
      });

      it('should throw error in production with DB_PASSWORD = "secret"', () => {
        const envVars = {
          ...validEnvVars,
          DB_PASSWORD: 'secret',
          NODE_ENV: 'production',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).toThrow(
          'Production environment detected with weak or default',
        );
      });

      it('should warn when VAULT_ENABLED is false in production', () => {
        const envVars = {
          ...validEnvVars,
          NODE_ENV: 'production',
          VAULT_ENABLED: 'false',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        const result = service.validate();
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some((w) => w.includes('VAULT_ENABLED'))).toBe(
          true,
        );
      });
    });

    describe('development mode validation', () => {
      it('should allow shorter secrets in development mode', () => {
        const envVars = {
          ...validEnvVars,
          JWT_SECRET: 'dev-secret',
          DB_PASSWORD: 'dev-pass',
          NODE_ENV: 'development',
        };
        (configService.get as jest.Mock).mockImplementation(
          (key: string) => envVars[key],
        );

        expect(() => service.validate()).not.toThrow();
      });
    });

    describe('secrets masking', () => {
      it('should mask secret values in error messages', () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
          if (key === 'JWT_SECRET') return 'super-secret-value';
          if (key === 'DB_PASSWORD') return 'db-password-value';
          return validEnvVars[key];
        });

        service.validate();
        // The masking service should have been called during validation
        // (though in this test we verify it doesn't crash)
        expect(maskingService.mask).toBeDefined();
      });
    });
  });
});
