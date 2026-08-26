import { IsString, IsNotEmpty, IsOptional, Matches, IsIn } from 'class-validator';

/**
 * DTO for rotating a secret at runtime.
 * Used by the secrets rotation endpoint to validate and process rotation requests.
 */
export class RotateSecretDto {
  /**
   * The canonical environment variable name of the secret to rotate.
   * Must be one of the known rotatable secrets.
   */
  @IsString()
  @IsNotEmpty()
  @IsIn([
    'JWT_SECRET',
    'DB_PASSWORD',
    'REDIS_PASSWORD',
    'REDIS_URL',
    'VAULT_TOKEN',
    'LLM_API_KEY',
    'STRIPE_SECRET_KEY',
    'WEBHOOK_SECRET_KEY',
  ], {
    message: 'secretKey must be one of the known rotatable secrets',
  })
  secretKey!: string;

  /**
   * The new secret value to apply.
   * Will be validated based on the secret type before being applied.
   */
  @IsString()
  @IsNotEmpty()
  newValue!: string;

  /**
   * Optional reason for the rotation (e.g., 'scheduled', 'manual', 'vault-renewal').
   * Used for audit logging and monitoring.
   */
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9_-]+$/, {
    message: 'reason must contain only lowercase letters, numbers, hyphens, and underscores',
  })
  reason?: string;

  /**
   * Optional actor identifier (e.g., user ID, service name).
   * If not provided, will be inferred from the request context.
   */
  @IsString()
  @IsOptional()
  actorId?: string;
}
