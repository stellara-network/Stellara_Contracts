import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { UserController } from './user.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { ReputationModule } from './reputation/reputation.module';
import { DatabaseModule } from './database.module';
import { IndexerModule } from './indexer/indexer.module';
import { NotificationModule } from './notification/notification.module';
import { AuthModule } from './auth/auth.module';
import { TenantModule } from './tenant/tenant.module';
import { WebhookModule } from './webhook/webhook.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    // Global rate limiting with Redis storage
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        ttl: 60, // time window in seconds
        limit: 100, // default requests per window
        storage: new ThrottlerStorageRedisService({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
        }),
      }),
    }),
    ReputationModule,
    DatabaseModule,
    IndexerModule,
    NotificationModule,
    AuthModule,
    TenantModule,
    WebhookModule,
  ],
  controllers: [AppController, UserController],
  providers: [AppService],
})
export class AppModule {}
