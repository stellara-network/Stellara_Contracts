import { Module, OnModuleInit, Inject } from '@nestjs/common';
import { BullModule, InjectQueue, getQueueToken } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueService } from './services/queue.service';
import { QueueIdempotencyGuard } from './queue-idempotency.guard';
import { DeployContractProcessor } from './processors/deploy-contract.processor';
import { ProcessTtsProcessor } from './processors/process-tts.processor';
import { IndexMarketNewsProcessor } from './processors/index-market-news.processor';
import { DeadLetterProcessor } from './processors/dead-letter.processor';
import { QueueAdminController } from './controllers/queue-admin.controller';
import { RedisModule } from '../redis/redis.module';
import { ObservabilityModule } from '../observability/observability.module';
import { QueueJobTracingWrapper } from '../observability/middleware/queue-job-tracing.wrapper';
import type { Queue } from 'bull';
import { buildBullRedisOptions } from '../redis/redis.config';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: buildBullRedisOptions({
          REDIS_URL: configService.get('REDIS_URL'),
          REDIS_HOST: configService.get('REDIS_HOST'),
          REDIS_PORT: configService.get('REDIS_PORT'),
          REDIS_PASSWORD: configService.get('REDIS_PASSWORD'),
          REDIS_QUEUE_DB: configService.get('REDIS_QUEUE_DB'),
        }),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: 'deploy-contract' },
      { name: 'process-tts' },
      { name: 'index-market-news' },
      { name: 'failed-jobs' },
    ),
    RedisModule,
    ObservabilityModule,
  ],
  controllers: [QueueAdminController],
  providers: [
    QueueService,
    QueueIdempotencyGuard,
    DeployContractProcessor,
    ProcessTtsProcessor,
    IndexMarketNewsProcessor,
    DeadLetterProcessor,
  ],
  exports: [QueueService, QueueIdempotencyGuard],
})
export class QueueModule implements OnModuleInit {
  constructor(
    private readonly queueJobTracingWrapper: QueueJobTracingWrapper,
    @InjectQueue('deploy-contract') private readonly deployContractQueue: Queue,
    @InjectQueue('process-tts') private readonly processTtsQueue: Queue,
    @InjectQueue('index-market-news') private readonly indexMarketNewsQueue: Queue,
  ) {}

  async onModuleInit() {
    // Wrap queues for metrics
    this.queueJobTracingWrapper.wrapQueueMetrics(this.deployContractQueue, 'deploy-contract');
    this.queueJobTracingWrapper.wrapQueueMetrics(this.processTtsQueue, 'process-tts');
    this.queueJobTracingWrapper.wrapQueueMetrics(this.indexMarketNewsQueue, 'index-market-news');
  }
}
