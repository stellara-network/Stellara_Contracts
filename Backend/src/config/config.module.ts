import { Module } from '@nestjs/common';
import { SecretsMaskingService } from './secrets-masking.service';
import { SecretsRotationService } from './secrets-rotation.service';
import { SecretsRotationHandlerService } from './secrets-rotation-handler.service';
import { SecretsController } from './controllers/secrets.controller';
import { AuditModule } from '../audit/audit.module';

/**
 * ConfigModule
 *
 * Centralizes configuration-related services including:
 * - Secrets masking for log sanitization
 * - Runtime secret rotation with validation
 * - Configuration validation
 */
@Module({
  imports: [AuditModule],
  controllers: [SecretsController],
  providers: [
    SecretsMaskingService,
    SecretsRotationService,
    SecretsRotationHandlerService,
  ],
  exports: [
    SecretsMaskingService,
    SecretsRotationService,
    SecretsRotationHandlerService,
  ],
})
export class ConfigModule {}
