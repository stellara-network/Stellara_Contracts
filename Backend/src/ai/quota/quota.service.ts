import { Injectable } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import dayjs from 'dayjs';


@Injectable()
export class QuotaService {
  private readonly MAX_REQUESTS = 1000;

  async assertQuota(userId: string) {
    const month = dayjs().format('YYYY-MM');

    const quota = await this.repo.findOneBy({ userId, month });

    if (quota && quota.requestCount >= this.MAX_REQUESTS) {
      throw new ForbiddenException({
        error: 'QuotaExceeded',
        message: 'Monthly AI usage quota exceeded',
      });
    }
  }

  async recordUsage(userId: string, tokens: number) {
    const month = dayjs().format('YYYY-MM');

    await this.repo.upsert(
      {
        userId,
        month,
        requestCount: () => 'request_count + 1',
        tokenCount: () => `token_count + ${tokens}`,
      },
      ['userId', 'month'],
    );
  }
}
