import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import supertest from 'supertest';

import { SecretsMaskingService } from './secrets-masking.service';
import { SecretsRotationService } from './secrets-rotation.service';
import { SecretsRotationHandlerService } from './secrets-rotation-handler.service';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { AuditLog, AuditLogArchive } from '../audit/audit.entity';

describe('Secrets Integration Tests', () => {
  let app: INestApplication;
  let maskingService: SecretsMaskingService;
  let rotationService: SecretsRotationService;
  let rotationHandlerService: SecretsRotationHandlerService;
  let auditService: AuditService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ envFilePath: '.env.test', isGlobal: true }),

        // Configure test database connection
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            type: 'postgres',
            host: config.get('DB_HOST') || 'localhost',
            port: config.get('DB_PORT') || 5432,
            username: config.get('DB_USERNAME') || 'postgres',
            password: config.get('DB_PASSWORD') || 'test',
            database: config.get('DB_DATABASE') || 'test_db',
            entities: [AuditLog, AuditLogArchive],
            synchronize: true, // Auto-create schema for tests
            logging: false,
          }),
        }),

        TypeOrmModule.forFeature([AuditLog, AuditLogArchive]),
        AuditModule,
      ],
      providers: [
        SecretsMaskingService,
        SecretsRotationService,
        SecretsRotationHandlerService,
        {
          // Bypass authorization checks during integration tests
          provide: APP_GUARD,
          useValue: { canActivate: () => true },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    maskingService = moduleRef.get<SecretsMaskingService>(SecretsMaskingService);
    rotationService = moduleRef.get<SecretsRotationService>(SecretsRotationService);
    rotationHandlerService = moduleRef.get<SecretsRotationHandlerService>(SecretsRotationHandlerService);
    auditService = moduleRef.get<AuditService>(AuditService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Secrets Masking', () => {
    beforeEach(async () => {
      // Set up test environment variables
      process.env.JWT_SECRET = 'test-jwt-secret-key-for-masking-testing';
      process.env.DB_PASSWORD = 'test-db-password-for-masking';
      process.env.REDIS_PASSWORD = 'test-redis-password';
    });

    afterEach(() => {
      // Clean up test environment variables
      delete process.env.JWT_SECRET;
      delete process.env.DB_PASSWORD;
      delete process.env.REDIS_PASSWORD;
    });

    it('should mask JWT_SECRET from strings', () => {
      const input = 'Connection failed: using JWT_SECRET=test-jwt-secret-key-for-masking-testing';
      const masked = maskingService.mask(input);
      
      expect(masked).toContain('***JWT_SECRET***');
      expect(masked).not.toContain('test-jwt-secret-key-for-masking-testing');
    });

    it('should mask DB_PASSWORD from strings', () => {
      const input = 'Database connection error: password=test-db-password-for-masking';
      const masked = maskingService.mask(input);
      
      expect(masked).toContain('***DB_PASSWORD***');
      expect(masked).not.toContain('test-db-password-for-masking');
    });

    it('should mask Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
      const masked = maskingService.mask(input);
      
      expect(masked).toContain('Bearer ***JWT***');
      expect(masked).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    });

    it('should mask passwords in connection URLs', () => {
      const input = 'Connecting to redis://:my-secret-password@localhost:6379';
      const masked = maskingService.mask(input);
      
      expect(masked).toContain('redis://***:***@');
      expect(masked).not.toContain('my-secret-password');
    });

    it('should mask query string secrets', () => {
      const input = 'Request: https://api.example.com?token=secret123&password=mypass';
      const masked = maskingService.mask(input);
      
      expect(masked).toContain('token=***');
      expect(masked).toContain('password=***');
      expect(masked).not.toContain('secret123');
      expect(masked).not.toContain('mypass');
    });

    it('should mask JSON secret fields', () => {
      const input = '{"password":"secret123","token":"abc123"}';
      const masked = maskingService.mask(input);
      
      expect(masked).toContain('"password":"***"');
      expect(masked).toContain('"token":"***"');
      expect(masked).not.toContain('secret123');
      expect(masked).not.toContain('abc123');
    });

    it('should mask Error objects', () => {
      const error = new Error('Failed to connect with JWT_SECRET=test-jwt-secret-key-for-masking-testing');
      const maskedError = maskingService.maskError(error);
      
      expect(maskedError.message).toContain('***JWT_SECRET***');
      expect(maskedError.message).not.toContain('test-jwt-secret-key-for-masking-testing');
    });

    it('should mask stack traces', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at Context.<anonymous> (test.spec.ts:10:15)\n    with secret=test-jwt-secret-key-for-masking-testing';
      const maskedError = maskingService.maskError(error);
      
      expect(maskedError.stack).toContain('***JWT_SECRET***');
      expect(maskedError.stack).not.toContain('test-jwt-secret-key-for-masking-testing');
    });

    it('should mask objects recursively', () => {
      const input = {
        connection: {
          url: 'redis://:my-secret-password@localhost:6379',
          token: 'secret123',
        },
        metadata: {
          password: 'mypass',
        },
      };
      
      const masked = maskingService.maskObject(input) as any;
      
      expect(masked.connection.url).toContain('***:***@');
      expect(masked.connection.token).toContain('***');
      expect(masked.metadata.password).toContain('***');
    });

    it('should handle arrays in object masking', () => {
      const input = {
        tokens: ['secret1', 'secret2', 'secret3'],
        passwords: ['pass1', 'pass2'],
      };
      
      const masked = maskingService.maskObject(input) as any;
      
      // Array elements should be masked if they match patterns
      expect(masked.tokens).toBeInstanceOf(Array);
      expect(masked.passwords).toBeInstanceOf(Array);
    });

    it('should not mask non-matching strings', () => {
      const input = 'This is a normal log message without secrets';
      const masked = maskingService.mask(input);
      
      expect(masked).toBe(input);
    });

    it('should handle empty strings', () => {
      const masked = maskingService.mask('');
      expect(masked).toBe('');
    });

    it('should handle null and undefined', () => {
      expect(maskingService.mask(null as any)).toBe(null);
      expect(maskingService.mask(undefined as any)).toBe(undefined);
    });
  });

  describe('Secrets Rotation', () => {
    beforeEach(async () => {
      // Set up test environment variables
      process.env.JWT_SECRET = 'old-jwt-secret-key';
      process.env.DB_PASSWORD = 'old-db-password';
      process.env.REDIS_PASSWORD = 'old-redis-password';
      
      // Clear audit logs
      await auditService.clearAllLogs();
    });

    afterEach(() => {
      // Clean up test environment variables
      delete process.env.JWT_SECRET;
      delete process.env.DB_PASSWORD;
      delete process.env.REDIS_PASSWORD;
    });

    it('should validate JWT_SECRET format', () => {
      // Valid JWT secret
      expect(() => {
        rotationHandlerService['validateSecretValue']('JWT_SECRET', 'this-is-a-valid-jwt-secret-with-32-chars-min');
      }).not.toThrow();

      // Too short
      expect(() => {
        rotationHandlerService['validateSecretValue']('JWT_SECRET', 'short');
      }).toThrow('too short');

      // Weak password
      expect(() => {
        rotationHandlerService['validateSecretValue']('JWT_SECRET', 'default-secret-change-in-production');
      }).toThrow('weak or default');
    });

    it('should validate DB_PASSWORD format', () => {
      // Valid DB password
      expect(() => {
        rotationHandlerService['validateSecretValue']('DB_PASSWORD', 'this-is-a-valid-db-password-16');
      }).not.toThrow();

      // Too short
      expect(() => {
        rotationHandlerService['validateSecretValue']('DB_PASSWORD', 'short');
      }).toThrow('too short');
    });

    it('should validate REDIS_URL format', () => {
      // Valid Redis URL
      expect(() => {
        rotationHandlerService['validateSecretValue']('REDIS_URL', 'redis://localhost:6379');
      }).not.toThrow();

      expect(() => {
        rotationHandlerService['validateSecretValue']('REDIS_URL', 'rediss://localhost:6379');
      }).not.toThrow();

      // Invalid format
      expect(() => {
        rotationHandlerService['validateSecretValue']('REDIS_URL', 'not-a-redis-url');
      }).toThrow('must be a valid Redis URL');
    });

    it('should validate LLM_API_KEY format', () => {
      // Valid API key
      expect(() => {
        rotationHandlerService['validateSecretValue']('LLM_API_KEY', 'sk-test123456789');
      }).not.toThrow();

      // Invalid format
      expect(() => {
        rotationHandlerService['validateSecretValue']('LLM_API_KEY', 'invalid-key');
      }).toThrow('must be a valid API key format');
    });

    it('should validate STRIPE_SECRET_KEY format', () => {
      // Valid Stripe keys
      expect(() => {
        rotationHandlerService['validateSecretValue']('STRIPE_SECRET_KEY', 'sk_test_1234567890');
      }).not.toThrow();

      expect(() => {
        rotationHandlerService['validateSecretValue']('STRIPE_SECRET_KEY', 'sk_live_1234567890');
      }).not.toThrow();

      // Invalid format
      expect(() => {
        rotationHandlerService['validateSecretValue']('STRIPE_SECRET_KEY', 'invalid-stripe-key');
      }).toThrow('must be a valid Stripe secret key');
    });

    it('should validate WEBHOOK_SECRET_KEY format', () => {
      // Valid webhook key (64 hex chars)
      expect(() => {
        rotationHandlerService['validateSecretValue']('WEBHOOK_SECRET_KEY', 'a'.repeat(64));
      }).not.toThrow();

      // Invalid format
      expect(() => {
        rotationHandlerService['validateSecretValue']('WEBHOOK_SECRET_KEY', 'not-64-hex-chars');
      }).toThrow('must be a 64-character hexadecimal string');
    });

    it('should rotate JWT_SECRET successfully', async () => {
      const newSecret = 'new-jwt-secret-key-with-32-chars-minimum';
      const actorId = 'test-user-123';

      const result = await rotationHandlerService.rotateSecret(
        {
          secretKey: 'JWT_SECRET',
          newValue: newSecret,
          reason: 'test',
        },
        actorId,
      );

      expect(result.success).toBe(true);
      expect(result.secretKey).toBe('JWT_SECRET');
      expect(result.reason).toBe('test');
      expect(process.env.JWT_SECRET).toBe(newSecret);
    });

    it('should audit successful rotation', async () => {
      const newSecret = 'new-jwt-secret-key-with-32-chars-minimum';
      const actorId = 'test-user-123';

      await rotationHandlerService.rotateSecret(
        {
          secretKey: 'JWT_SECRET',
          newValue: newSecret,
          reason: 'test',
        },
        actorId,
      );

      const logs = await auditService.getLogs(1, 10, {
        action_type: 'SECRET_ROTATED',
      });

      expect(logs.data).toHaveLength(1);
      expect(logs.data[0].action_type).toBe('SECRET_ROTATED');
      expect(logs.data[0].actor_id).toBe(actorId);
      expect(logs.data[0].entity_id).toBe('JWT_SECRET');
    });

    it('should audit failed rotation', async () => {
      const actorId = 'test-user-123';

      try {
        await rotationHandlerService.rotateSecret(
          {
            secretKey: 'JWT_SECRET',
            newValue: 'short', // Too short, will fail validation
            reason: 'test',
          },
          actorId,
        );
        fail('Should have thrown validation error');
      } catch (error) {
        // Expected to fail
      }

      const logs = await auditService.getLogs(1, 10, {
        action_type: 'SECRET_ROTATION_FAILED',
      });

      expect(logs.data).toHaveLength(1);
      expect(logs.data[0].action_type).toBe('SECRET_ROTATION_FAILED');
      expect(logs.data[0].actor_id).toBe(actorId);
      expect(logs.data[0].entity_id).toBe('JWT_SECRET');
    });

    it('should trigger rotation handlers via rotation service', async () => {
      let handlerCalled = false;
      let receivedEvent: any = null;

      // Register a test handler
      const unsubscribe = rotationService.onRotation('JWT_SECRET', async (event) => {
        handlerCalled = true;
        receivedEvent = event;
      });

      const newSecret = 'new-jwt-secret-key-with-32-chars-minimum';
      await rotationHandlerService.rotateSecret(
        {
          secretKey: 'JWT_SECRET',
          newValue: newSecret,
          reason: 'test',
        },
        'test-user',
      );

      expect(handlerCalled).toBe(true);
      expect(receivedEvent.secretKey).toBe('JWT_SECRET');
      expect(receivedEvent.reason).toBe('test');

      // Clean up
      unsubscribe();
    });

    it('should list rotatable secrets', () => {
      const secrets = rotationHandlerService.getRotatableSecrets();

      expect(secrets).toBeInstanceOf(Array);
      expect(secrets.length).toBeGreaterThan(0);
      
      const jwtSecret = secrets.find((s: any) => s.key === 'JWT_SECRET');
      expect(jwtSecret).toBeDefined();
      expect(jwtSecret.description).toContain('JWT');
    });

    it('should handle unknown secret keys with basic validation', () => {
      // Should not throw for unknown keys, but apply basic checks
      expect(() => {
        rotationHandlerService['validateSecretValue']('UNKNOWN_SECRET', 'reasonable-value-length');
      }).not.toThrow();

      expect(() => {
        rotationHandlerService['validateSecretValue']('UNKNOWN_SECRET', 'short');
      }).toThrow('too short');
    });

    it('should mask old values in audit logs', async () => {
      const oldSecret = 'old-jwt-secret-key';
      const newSecret = 'new-jwt-secret-key-with-32-chars-minimum';
      
      await rotationHandlerService.rotateSecret(
        {
          secretKey: 'JWT_SECRET',
          newValue: newSecret,
          reason: 'test',
        },
        'test-user',
      );

      const logs = await auditService.getLogs(1, 10, {
        action_type: 'SECRET_ROTATED',
      });

      expect(logs.data[0].metadata.oldValue).toContain('***');
      expect(logs.data[0].metadata.oldValue).not.toContain(oldSecret);
    });
  });

  describe('Rotation Service Event Bus', () => {
    it('should register and call rotation handlers', async () => {
      let handler1Called = false;
      let handler2Called = false;

      const unsubscribe1 = rotationService.onRotation('TEST_SECRET', async () => {
        handler1Called = true;
      });

      const unsubscribe2 = rotationService.onRotation('TEST_SECRET', async () => {
        handler2Called = true;
      });

      await rotationService.notifyRotation('TEST_SECRET', 'test');

      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);

      unsubscribe1();
      unsubscribe2();
    });

    it('should handle handler errors gracefully', async () => {
      let errorHandlerCalled = false;

      rotationService.onRotation('TEST_SECRET', async () => {
        throw new Error('Handler error');
      });

      rotationService.onRotation('TEST_SECRET', async () => {
        errorHandlerCalled = true;
      });

      // Should not throw despite handler error
      await expect(rotationService.notifyRotation('TEST_SECRET', 'test')).resolves.not.toThrow();
      
      // Second handler should still be called
      expect(errorHandlerCalled).toBe(true);
    });

    it('should support bulk rotation notification', async () => {
      const notifications: string[] = [];

      rotationService.onRotation('SECRET1', async (evt) => {
        notifications.push(evt.secretKey);
      });

      rotationService.onRotation('SECRET2', async (evt) => {
        notifications.push(evt.secretKey);
      });

      await rotationService.notifyBulkRotation(['SECRET1', 'SECRET2'], 'bulk-test');

      expect(notifications).toEqual(['SECRET1', 'SECRET2']);
    });

    it('should list registered secrets', () => {
      rotationService.onRotation('REGISTERED_SECRET', async () => {});

      const registered = rotationService.registeredSecrets();
      
      expect(registered).toContain('REGISTERED_SECRET');
    });
  });
});
