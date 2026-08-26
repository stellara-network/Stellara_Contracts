import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { buildTypeOrmOptions } from './database/database.config';

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
import { ConfigModule } from './config/config.module';

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
import { validateEnvironment } from './config/environment-validation';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),

    ScheduleModule.forRoot(),

    TypeOrmModule.forRootAsync({
      imports: [NestConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => buildTypeOrmOptions({
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get('DB_PORT', 5432),
        username: configService.get('DB_USERNAME', 'postgres'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_DATABASE', 'stellara_workflows'),
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
        logging: configService.get('NODE_ENV') === 'development',
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
    ConfigModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    ConfigValidationService,
    StartupValidationService,

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
