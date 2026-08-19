import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { RedisModule } from './redis/redis.module';
import { VoiceModule } from './voice/voice.module';
import { StellarMonitorModule } from './stellar-monitor/stellar-monitor.module';
import { WorkflowModule } from './workflow/workflow.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { MarketDataModule } from './market-data/market-data.module';
import { AiModule } from './ai/ai.module';

import { RolesGuard } from './guards/roles.guard';
import { ConfigValidationService } from './config/config-validation.service';
import { StartupValidationService } from './config/startup-validation.service';
import { SecretsMaskingService } from './config/secrets-masking.service';
import { SecretsRotationService } from './config/secrets-rotation.service';

import { Workflow } from './workflow/entities/workflow.entity';
import { WorkflowStep } from './workflow/entities/workflow-step.entity';
import { User } from './auth/entities/user.entity';
import { WalletBinding } from './auth/entities/wallet-binding.entity';
import { LoginNonce } from './auth/entities/login-nonce.entity';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { ApiToken } from './auth/entities/api-token.entity';
import { AuditModule } from './audit/audit.module';
import { AuditLog, AuditLogArchive } from './audit/audit.entity';
import { VoiceJob } from './voice/entities/voice-job.entity';
import { ThrottleModule } from './throttle/throttle.module';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './observability/observability.module';
import { TracingInterceptor } from './observability/interceptors/tracing.interceptor';
import { CorrelationMiddleware } from './observability/middleware/correlation.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    ScheduleModule.forRoot(),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST') || 'localhost',
        port: configService.get('DB_PORT') || 5432,
        username: configService.get('DB_USERNAME') || 'postgres',
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_DATABASE') || 'stellara_workflows',
        entities: [
          Workflow,
          WorkflowStep,
          User,
          WalletBinding,
          LoginNonce,
          RefreshToken,
          ApiToken,
          AuditLog,
          AuditLogArchive,
          VoiceJob,
        ],
        synchronize: false,
        logging: configService.get('NODE_ENV') === 'development',
        extra: {
          max: 20,
          min: 5,
          idleTimeoutMillis: 30000,
        },
        retryAttempts: 5,
        retryDelay: 3000,
        migrations: ['src/database/migrations/*{.ts,.js}'],
      }),
    }),

    RedisModule,
    AuthModule,
    VoiceModule,
    StellarMonitorModule,
    WorkflowModule,
    QueueModule,
    MarketDataModule,
    AuditModule,
    ThrottleModule,
    AiModule,
    HealthModule,
    ObservabilityModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    ConfigValidationService,
    StartupValidationService,
    SecretsMaskingService,
    SecretsRotationService,

    /**
     * Global RBAC enforcement
     * Applies @Roles() checks across all controllers
     */
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },

    /**
     * Global tracing interceptor — propagates trace IDs and records
     * HTTP request metrics via ObservabilityModule.
     */
    {
      provide: APP_INTERCEPTOR,
      useClass: TracingInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
