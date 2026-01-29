import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisService
  implements OnModuleInit, OnModuleDestroy
{
  public client: RedisClientType;
  public pubClient: RedisClientType;
  public subClient: RedisClientType;

   constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });
  }

  async onModuleInit() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';

    this.client = createClient({ url });
    this.pubClient = createClient({ url });
    this.subClient = createClient({ url });

    await Promise.all([
      this.client.connect(),
      this.pubClient.connect(),
      this.subClient.connect(),
    ]);
  }

  async onModuleDestroy() {
    await Promise.all([
      this.client.quit(),
      this.pubClient.quit(),
      this.subClient.quit(),
    ]);
  }
}
