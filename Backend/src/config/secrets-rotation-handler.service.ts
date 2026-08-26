import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretsRotationService } from './secrets-rotation.service';
import { SecretsMaskingService } from './secrets-masking.service';
import { RotateSecretDto } from './dto/rotate-secret.dto';

/**
 * Validation rules for specific secret types.
 */
interface SecretValidationRule {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternDescription?: string;
}

/**
 * Result of a secret rotation operation.
 */
export interface RotationResult {
  success: boolean;
  secretKey: string;
  rotatedAt: string;
  reason: string;
  oldValue?: string;
  newValueLength: number;
}

/**
 * SecretsRotationHandlerService
 *
 * Handles the business logic for rotating secrets at runtime, including:
 * - Validation of new secret values before application
 * - Audit logging of rotation operations with actor and timestamp
 * - Integration with the rotation event bus
 * - Safe runtime configuration updates without code changes
 */
@Injectable()
export class SecretsRotationHandlerService {
  private readonly logger = new Logger(SecretsRotationHandlerService.name);

  /**
   * Validation rules for known secret types.
   */
  private static readonly VALIDATION_RULES: Record<string, SecretValidationRule> = {
    JWT_SECRET: {
      minLength: 32,
      pattern: /^[A-Za-z0-9+/=_\-]{32,}$/,
      patternDescription: 'must be at least 32 characters and contain only valid base64 characters',
    },
    DB_PASSWORD: {
      minLength: 16,
      patternDescription: 'must be at least 16 characters',
    },
    REDIS_PASSWORD: {
      minLength: 8,
      patternDescription: 'must be at least 8 characters',
    },
    REDIS_URL: {
      pattern: /^rediss?:\/\/.+$/,
      patternDescription: 'must be a valid Redis URL (redis:// or rediss://)',
    },
    VAULT_TOKEN: {
      minLength: 20,
      patternDescription: 'must be at least 20 characters',
    },
    LLM_API_KEY: {
      minLength: 10,
      pattern: /^sk-[a-zA-Z0-9]+$/,
      patternDescription: 'must be a valid API key format (sk- followed by alphanumeric characters)',
    },
    STRIPE_SECRET_KEY: {
      pattern: /^sk_(test|live)_[a-zA-Z0-9]+$/,
      patternDescription: 'must be a valid Stripe secret key (sk_test_ or sk_live_)',
    },
    WEBHOOK_SECRET_KEY: {
      pattern: /^[0-9a-f]{64}$/i,
      patternDescription: 'must be a 64-character hexadecimal string (32 bytes)',
    },
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly rotationService: SecretsRotationService,
    private readonly maskingService: SecretsMaskingService,
  ) {}

  /**
   * Validate a new secret value based on its type.
   *
   * @param secretKey The canonical name of the secret.
   * @param newValue The new value to validate.
   * @throws BadRequestException if validation fails.
   */
  private validateSecretValue(secretKey: string, newValue: string): void {
    const rule = SecretsRotationHandlerService.VALIDATION_RULES[secretKey];

    if (!rule) {
      this.logger.warn(`No validation rule found for secret: ${secretKey}, allowing with basic checks`);
      // Basic validation: ensure it's not empty and not a common default
      if (!newValue || newValue.length < 4) {
        throw new BadRequestException(
          `New value for ${secretKey} is too short (minimum 4 characters)`,
        );
      }
      return;
    }

    // Check minimum length
    if (rule.minLength && newValue.length < rule.minLength) {
      throw new BadRequestException(
        `New value for ${secretKey} ${rule.patternDescription || `must be at least ${rule.minLength} characters`}`,
      );
    }

    // Check maximum length
    if (rule.maxLength && newValue.length > rule.maxLength) {
      throw new BadRequestException(
        `New value for ${secretKey} must be at most ${rule.maxLength} characters`,
      );
    }

    // Check pattern
    if (rule.pattern && !rule.pattern.test(newValue)) {
      throw new BadRequestException(
        `New value for ${secretKey} ${rule.patternDescription}`,
      );
    }

    // Check for common weak/default values
    const weakPatterns = [
      'default-secret-change-in-production',
      'secret',
      'password',
      'changeme',
      'change-in-production',
      'your-super-secret-jwt-key-change-in-production',
      'dev-secret-key',
      'devpassword',
    ];

    if (weakPatterns.includes(newValue.toLowerCase())) {
      throw new BadRequestException(
        `New value for ${secretKey} appears to be a weak or default password. Please use a strong, unique value.`,
      );
    }
  }

  /**
   * Apply a new secret value to the runtime configuration.
   * This updates process.env and notifies the rotation service.
   *
   * @param secretKey The canonical name of the secret.
   * @param newValue The new value to apply.
   */
  private applySecretValue(secretKey: string, newValue: string): void {
    // Update process.env for the current process
    process.env[secretKey] = newValue;

    // Note: In a production environment with multiple instances, you would also:
    // 1. Update the secret store (Vault, AWS Secrets Manager, etc.)
    // 2. Notify other instances via a message bus or load balancer health check
    // 3. Trigger a rolling restart or configuration reload across all instances

    this.logger.log(`Applied new value for ${secretKey} to runtime configuration`);
  }

  /**
   * Rotate a secret with full validation, auditing, and notification.
   *
   * @param dto The rotation request containing secret key, new value, and optional metadata.
   * @param actorId The ID of the actor performing the rotation (user or service).
   * @returns A success message with rotation details.
   */
  async rotateSecret(dto: RotateSecretDto, actorId: string): Promise<RotationResult> {
    const { secretKey, newValue, reason = 'manual' } = dto;

    this.logger.log(
      `Secret rotation requested: ${secretKey} by actor ${actorId} (reason: ${reason})`,
    );

    // 1. Validate the new value
    try {
      this.validateSecretValue(secretKey, newValue);
    } catch (error) {
      // Audit logging is handled by the controller layer
      throw error;
    }

    // 2. Get the old value for audit (masked)
    const oldValue = process.env[secretKey];
    const maskedOldValue = this.maskingService.mask(oldValue || '[none]');

    // 3. Apply the new value
    this.applySecretValue(secretKey, newValue);

    // 4. Notify the rotation service to trigger registered handlers
    try {
      await this.rotationService.notifyRotation(secretKey, reason);
    } catch (error) {
      this.logger.error(
        `Rotation notification failed for ${secretKey}: ${(error as Error).message}`,
      );
      // Continue anyway - the secret has been applied, handlers can recover
    }

    // 5. Return rotation result (audit logging is handled by controller)
    const rotatedAt = new Date().toISOString();

    this.logger.log(
      `Secret rotation completed successfully: ${secretKey} at ${rotatedAt}`,
    );

    return {
      success: true,
      secretKey,
      rotatedAt,
      reason,
      oldValue: maskedOldValue,
      newValueLength: newValue.length,
    };
  }

  /**
   * Get the list of rotatable secrets for documentation/UI purposes.
   */
  getRotatableSecrets(): Array<{
    key: string;
    description: string;
    validationRule?: string;
  }> {
    return Object.entries(SecretsRotationHandlerService.VALIDATION_RULES).map(
      ([key, rule]) => ({
        key,
        description: this.getSecretDescription(key),
        validationRule: rule.patternDescription,
      }),
    );
  }

  /**
   * Get a human-readable description for a secret key.
   */
  private getSecretDescription(secretKey: string): string {
    const descriptions: Record<string, string> = {
      JWT_SECRET: 'JWT signing key for access token generation',
      DB_PASSWORD: 'PostgreSQL database password',
      REDIS_PASSWORD: 'Redis authentication password',
      REDIS_URL: 'Redis connection URL',
      VAULT_TOKEN: 'HashiCorp Vault authentication token',
      LLM_API_KEY: 'External LLM service API key',
      STRIPE_SECRET_KEY: 'Stripe payment processing secret key',
      WEBHOOK_SECRET_KEY: 'Webhook signature verification key',
    };
    return descriptions[secretKey] || 'Application secret';
  }
}
