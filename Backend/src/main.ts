import { NestFactory } from '@nestjs/core';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './websocket/redis-io.adapter';
import { ThrottleGuard } from './throttle/throttle.guard';
import { ConfigValidationService } from './config/config-validation.service';
import { StartupValidationService } from './config/startup-validation.service';
import { SecretsMaskingService } from './config/secrets-masking.service';
import { SecretsRotationService } from './config/secrets-rotation.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { CorrelationMiddleware } from './observability/middleware/correlation.middleware';

/**
 * Lightweight inline masker used before the DI container is ready
 * (i.e., in the top-level bootstrap().catch handler).
 * Replaces any literal value of every known secret env-var with `***KEY***`.
 */
function maskBootstrapError(message: string): string {
  const knownKeys = [
    'JWT_SECRET', 'DB_PASSWORD', 'REDIS_URL', 'REDIS_PASSWORD',
    'DATABASE_URL', 'VAULT_TOKEN', 'LLM_API_KEY', 'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY',
  ];
  let safe = message;
  for (const key of knownKeys) {
    const value = process.env[key];
    if (value && value.length >= 4 && safe.includes(value)) {
      safe = safe.split(value).join(`***${key}***`);
    }
  }
  // Also mask passwords in connection URLs
  safe = safe.replace(/(rediss?|postgres|mysql|mongodb):\/\/[^:@\s]*:[^@\s]+@/gi, '$1://***:***@');
  return safe;
}

let app: INestApplication;

async function bootstrap() {
  const bootstrapStart = Date.now();
  const logger = new Logger('Bootstrap');

  // ConfigModule.forRoot validates the environment before the remaining
  // modules and providers are initialized.
  logger.log('Phase 1/3: Creating application container and validating configuration…');
  const containerStart = Date.now();

  app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug'],
  });

  app.enableShutdownHooks();

  logger.log(`Phase 1/3: ✅ Container ready (${Date.now() - containerStart}ms)`);

  // ── Phase 3: Configuration validation ────────────────────────────────────
  // Validates all env vars against the ConfigDto schema (type, range, format).
  logger.log('Phase 2/3: Running configuration schema validation…');
  const configStart = Date.now();

  const maskingService = app.get(SecretsMaskingService);
  const rotationService = app.get(SecretsRotationService);

  Logger.log(
    `SecretsMaskingService ready — ${rotationService.registeredSecrets().length} rotation hooks registered`,
    'Bootstrap',
  );

  try {
    const configValidationService = app.get(ConfigValidationService);
    const configResult = configValidationService.validate();
    logger.log(
      `Phase 2/3: ✅ Configuration valid (${configResult.warnings.length} warning(s), ${Date.now() - configStart}ms)`,
    );
  } catch (err) {
    const safeMessage = maskingService.mask((err as Error).message);
    Logger.error(
      `Phase 2/3: ❌ Configuration validation failed: ${safeMessage}`,
      'Bootstrap',
    );
    process.exit(1);
  }

  // ── Phase 4: Dependency connectivity checks ──────────────────────────────
  // Validates DB, Redis, and Queue configuration at startup with timeouts.
  logger.log('Phase 3/3: Validating dependency connectivity…');
  const depStart = Date.now();

  try {
    const startupValidationService = app.get(StartupValidationService);
    const report = await startupValidationService.validate({
      timeoutMs: parseInt(process.env.STARTUP_CHECK_TIMEOUT_MS || '5000', 10),
      failOnError: true,
    });

    if (report.success) {
      logger.log(
        `Phase 3/3: ✅ All dependencies healthy (${Date.now() - depStart}ms)`,
      );
    } else {
      const failedDeps = report.checks
        .filter((c) => c.status === 'error')
        .map((c) => c.name)
        .join(', ');
      logger.warn(
        `Phase 3/3: ⚠️  Some dependencies unhealthy (${failedDeps})`,
      );
    }
  } catch (err) {
    const safeMessage = maskingService.mask((err as Error).message);
    Logger.error(
      `Phase 3/3: ❌ Startup dependency validation failed: ${safeMessage}`,
      'Bootstrap',
    );
    process.exit(1);
  }

  // ── Post-validation: Configure middleware & guards ────────────────────────
  logger.log('Configuring middleware and guards…');

  // Enable validation globally
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Error handling & response shaping
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Stellara API')
    .setDescription(
      'API for authentication, monitoring Stellar network events, and delivering webhooks',
    )
    .setVersion('1.0')
    .addTag('Authentication')
    .addTag('Stellar Monitor')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // WebSocket adapter
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Global guards
  app.useGlobalGuards(app.get(ThrottleGuard));

  // ── Start listening ───────────────────────────────────────────────────────
  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  const totalTimeMs = Date.now() - bootstrapStart;
  logger.log(
    `🚀 Application is running on port ${port} (startup completed in ${totalTimeMs}ms)`,
  );
}

bootstrap().catch((err) => {
  // Use the module-scoped inline masker — DI may not be available here
  const safeMessage = maskBootstrapError((err as Error).message);
  const safeStack = maskBootstrapError((err as Error).stack ?? '');
  Logger.error(
    `Failed to start application: ${safeMessage}`,
    safeStack,
    'Bootstrap',
  );
  process.exit(1);
});

const shutdownLogger = new Logger('Shutdown');

async function handleShutdown(signal: string): Promise<void> {
  shutdownLogger.log(`Received ${signal}. Starting graceful shutdown...`);
  try {
    if (app) {
      await app.close();
      shutdownLogger.log('Application closed successfully.');
    }
  } catch (err) {
    shutdownLogger.error(`Error during shutdown: ${(err as Error).message}`);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
