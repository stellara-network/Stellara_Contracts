import { Module } from '@nestjs/common';
import { ThrottleService } from './throttle.service';
import { ThrottleGuard } from './throttle.guard';
import { RedisService } from 'src/redis/redis.service';

@Module({
  providers: [RedisService, ThrottleService, ThrottleGuard],
  exports: [ThrottleGuard],
})
export class ThrottleModule {}
