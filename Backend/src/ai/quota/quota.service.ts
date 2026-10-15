import {
  Injectable,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

export interface UserBudgetLimit {
  maxRequests?: number;
  maxMonthlyTokens?: number;
  maxTokensPerRequest?: number;
}

export interface QuotaUsageDetails {
  userId: string;
  month: string;
  requestCount: number;
  tokenCount: number;
  maxRequests: number;
  maxMonthlyTokens: number;
  maxTokensPerRequest: number;
  remainingRequests: number;
  remainingTokens: number;
  isBudgetExceeded: boolean;
}

/**
 * Service enforcing monthly request quotas, token budgets, and expensive single-request limits.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly defaultMaxRequests: number;
  private readonly defaultMaxMonthlyTokens: number;
  private readonly defaultMaxTokensPerRequest: number;
  // TTL slightly over 31 days so a key always covers its full month
  private readonly TTL_SECONDS = 31 * 24 * 60 * 60;

  // In-memory fallback if Redis is not configured or in local unit tests
  private readonly inMemoryRequests = new Map<string, number>();
  private readonly inMemoryTokens = new Map<string, number>();
  private readonly userBudgets = new Map<string, UserBudgetLimit>();

  constructor(
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.defaultMaxRequests = Number(
      this.configService?.get('AI_MAX_REQUESTS') ?? 1000,
    );
    this.defaultMaxMonthlyTokens = Number(
      this.configService?.get('AI_MONTHLY_TOKEN_BUDGET') ?? 500000,
    );
    this.defaultMaxTokensPerRequest = Number(
      this.configService?.get('AI_MAX_TOKENS_PER_REQUEST') ?? 8000,
    );
  }

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  private requestKey(userId: string): string {
    return `ai:quota:req:${userId}:${this.currentMonth()}`;
  }

  private tokenKey(userId: string): string {
    return `ai:quota:tok:${userId}:${this.currentMonth()}`;
  }

  /**
   * Get effective limits for a user (combining custom user overrides with defaults).
   */
  getUserLimits(userId: string): {
    maxRequests: number;
    maxMonthlyTokens: number;
    maxTokensPerRequest: number;
  } {
    const custom = this.userBudgets.get(userId);
    return {
      maxRequests: custom?.maxRequests ?? this.defaultMaxRequests,
      maxMonthlyTokens:
        custom?.maxMonthlyTokens ?? this.defaultMaxMonthlyTokens,
      maxTokensPerRequest:
        custom?.maxTokensPerRequest ?? this.defaultMaxTokensPerRequest,
    };
  }

  /**
   * Configure custom budget thresholds for a specific user.
   */
  setUserBudget(userId: string, limits: UserBudgetLimit): void {
    this.userBudgets.set(userId, limits);
  }

  /**
   * Fetch current usage for a user in the current month.
   */
  private async getCurrentUsage(
    userId: string,
  ): Promise<{ requestCount: number; tokenCount: number }> {
    const rKey = this.requestKey(userId);
    const tKey = this.tokenKey(userId);

    if (this.redis?.client?.get) {
      try {
        const [rVal, tVal] = await Promise.all([
          this.redis.client.get(rKey),
          this.redis.client.get(tKey),
        ]);
        return {
          requestCount: rVal ? parseInt(rVal, 10) : 0,
          tokenCount: tVal ? parseInt(tVal, 10) : 0,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis get failed in QuotaService: ${msg}`);
      }
    }

    return {
      requestCount: this.inMemoryRequests.get(rKey) || 0,
      tokenCount: this.inMemoryTokens.get(tKey) || 0,
    };
  }

  /**
   * Assert that the user has not exceeded their monthly request quota,
   * single-request token budget, or monthly token budget.
   * Throws ForbiddenException if any threshold is exceeded.
   */
  async assertQuota(userId: string, estimatedTokens?: number): Promise<void> {
    const limits = this.getUserLimits(userId);

    // 1. Expensive single-request threshold check
    if (
      estimatedTokens !== undefined &&
      estimatedTokens > limits.maxTokensPerRequest
    ) {
      throw new ForbiddenException({
        error: 'RequestBudgetExceeded',
        message: `Estimated request cost of ${estimatedTokens} tokens exceeds single-request limit of ${limits.maxTokensPerRequest}`,
      });
    }

    // 2. Fetch current monthly usage
    const { requestCount, tokenCount } = await this.getCurrentUsage(userId);

    // 3. Request count quota check
    if (requestCount >= limits.maxRequests) {
      throw new ForbiddenException({
        error: 'QuotaExceeded',
        message: 'Monthly AI usage quota exceeded',
      });
    }

    // 4. Monthly token budget check
    const projectedTokens = tokenCount + (estimatedTokens || 0);
    if (
      tokenCount >= limits.maxMonthlyTokens ||
      (estimatedTokens && projectedTokens > limits.maxMonthlyTokens)
    ) {
      throw new ForbiddenException({
        error: 'BudgetExceeded',
        message: `Monthly AI token budget of ${limits.maxMonthlyTokens} tokens exceeded`,
      });
    }
  }

  /**
   * Record token and request usage for a user after a successful AI generation.
   */
  async recordUsage(userId: string, tokens: number): Promise<void> {
    const rKey = this.requestKey(userId);
    const tKey = this.tokenKey(userId);

    if (this.redis?.client?.incr) {
      try {
        const reqCount = await this.redis.client.incr(rKey);
        if (reqCount === 1 && this.redis.client.expire) {
          await this.redis.client.expire(rKey, this.TTL_SECONDS);
        }

        const tokCount = await this.redis.client.incrBy(tKey, tokens);
        if (tokCount === tokens && this.redis.client.expire) {
          await this.redis.client.expire(tKey, this.TTL_SECONDS);
        }
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis recordUsage failed: ${msg}`);
      }
    }

    const currentReqs = this.inMemoryRequests.get(rKey) || 0;
    this.inMemoryRequests.set(rKey, currentReqs + 1);

    const currentToks = this.inMemoryTokens.get(tKey) || 0;
    this.inMemoryTokens.set(tKey, currentToks + tokens);
  }

  /**
   * Get comprehensive usage details and remaining budget for a user.
   */
  async getQuotaUsage(userId: string): Promise<QuotaUsageDetails> {
    const limits = this.getUserLimits(userId);
    const { requestCount, tokenCount } = await this.getCurrentUsage(userId);

    return {
      userId,
      month: this.currentMonth(),
      requestCount,
      tokenCount,
      maxRequests: limits.maxRequests,
      maxMonthlyTokens: limits.maxMonthlyTokens,
      maxTokensPerRequest: limits.maxTokensPerRequest,
      remainingRequests: Math.max(0, limits.maxRequests - requestCount),
      remainingTokens: Math.max(0, limits.maxMonthlyTokens - tokenCount),
      isBudgetExceeded:
        requestCount >= limits.maxRequests ||
        tokenCount >= limits.maxMonthlyTokens,
    };
  }

  /**
   * Reset quota and token usage for a user in the current month.
   */
  async resetQuota(userId: string): Promise<void> {
    const rKey = this.requestKey(userId);
    const tKey = this.tokenKey(userId);

    if (this.redis?.client?.del) {
      try {
        await Promise.all([
          this.redis.client.del(rKey),
          this.redis.client.del(tKey),
        ]);
      } catch {
        // Ignore reset deletion error
      }
    }

    this.inMemoryRequests.delete(rKey);
    this.inMemoryTokens.delete(tKey);
  }
}
