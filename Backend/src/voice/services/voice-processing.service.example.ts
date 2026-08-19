/**
 * Example Integration of Quota/Cache/Fallback with Voice Gateway
 * This shows how to integrate the new LLM features into the existing voice system
 */

import { Injectable, Logger } from '@nestjs/common';
import { VoiceSessionService } from './voice-session.service';
import { LlmService } from './llm.service';
import { QuotaService } from './quota.service';

@Injectable()
export class VoiceProcessingService {
  private readonly logger = new Logger(VoiceProcessingService.name);

  constructor(
    private readonly voiceSessionService: VoiceSessionService,
    private readonly llmService: LlmService,
    private readonly quotaService: QuotaService,
  ) {}

  /**
   * Process user voice input and generate response
   * Integrates quota checking, caching, and fallback behavior
   */
  async processUserPrompt(
    userId: string,
    sessionId: string,
    userMessage: string,
  ): Promise<{
    response: string;
    cached: boolean;
    quotaStatus: any;
    shouldNotifyQuotaWarning: boolean;
  }> {
    try {
      // Get current session to verify it belongs to user
      const session = await this.voiceSessionService.getSession(sessionId);
      if (!session || session.userId !== userId) {
        throw new Error('Invalid session');
      }

      // Generate LLM response with full pipeline
      const llmResponse = await this.llmService.generateResponse(
        userId,
        sessionId,
        userMessage,
        {
          model: 'gpt-3.5-turbo',
          useCache: true, // Enable caching
          recordQuota: true, // Track usage
        },
      );

      // Check if user is approaching quota limit
      const quotaStatus = llmResponse.quotaStatus;
      const quotaPercentage = quotaStatus
        ? quotaStatus.monthlyUsage / quotaStatus.monthlyLimit
        : 0;
      const shouldWarnQuota = quotaPercentage > 0.9; // Warn at 90%

      // Log important metrics
      this.logger.debug(
        `User ${userId} - Cache: ${llmResponse.cached ? 'HIT' : 'MISS'} | ` +
          `Monthly: ${quotaStatus?.monthlyUsage ?? 0}/${quotaStatus?.monthlyLimit ?? 0}`,
      );

      return {
        response: llmResponse.content,
        cached: llmResponse.cached,
        quotaStatus,
        shouldNotifyQuotaWarning: shouldWarnQuota,
      };
    } catch (error) {
      if (error.status === 429) {
        // Quota exceeded - inform user
        this.logger.warn(`User ${userId} exceeded quota: ${error.message}`);
        return {
          response:
            `I apologize, but you've reached your usage limit for this month. ` +
            `Please try again next month or contact support for a quota increase.`,
          cached: false,
          quotaStatus: await this.quotaService.getQuotaStatus(
            userId,
            sessionId,
          ),
          shouldNotifyQuotaWarning: false,
        };
      }

      // For any other error, use fallback response
      this.logger.error(
        `Error processing prompt for user ${userId}: ${error.message}`,
      );
      return {
        response:
          "I'm having trouble processing your request right now. Please try again.",
        cached: false,
        quotaStatus: await this.quotaService.getQuotaStatus(userId, sessionId),
        shouldNotifyQuotaWarning: false,
      };
    }
  }

  /**
   * Process user prompt with guaranteed fallback
   * Never throws exceptions - always returns a response
   */
  async processUserPromptWithFallback(
    userId: string,
    sessionId: string,
    userMessage: string,
  ): Promise<string> {
    const response = await this.llmService.generateResponseWithFallback(
      userId,
      sessionId,
      userMessage,
    );

    return response.content;
  }

  /**
   * Get user quota status for UI display
   */
  async getUserQuotaInfo(userId: string, sessionId: string) {
    const status = await this.quotaService.getQuotaStatus(userId, sessionId);

    return {
      monthlyUsage: status.monthlyUsage,
      monthlyLimit: status.monthlyLimit,
      monthlyRemaining: status.monthlyLimit - status.monthlyUsage,
      monthlyPercentage: (status.monthlyUsage / status.monthlyLimit) * 100,
      sessionUsage: status.sessionUsage,
      sessionLimit: status.sessionLimit,
      sessionRemaining: status.sessionLimit - status.sessionUsage,
      requestsThisMinute: status.requestsThisMinute,
      requestsPerMinuteLimit: status.requestsPerMinuteLimit,
    };
  }

  /**
   * Check if user can make another request
   */
  async canUserMakeRequest(
    userId: string,
    sessionId: string,
  ): Promise<boolean> {
    try {
      await this.quotaService.enforceQuota(userId, sessionId);
      return true;
    } catch (error) {
      if (error.status === 429) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Terminate session and clean up quota tracking
   */
  async terminateUserSession(sessionId: string): Promise<void> {
    const session = await this.voiceSessionService.getSession(sessionId);
    if (session) {
      // Clean up quota data
      await this.quotaService.resetSessionQuota(sessionId);

      // Terminate session normally
      await this.voiceSessionService.terminateSession(sessionId);

      this.logger.log(
        `Terminated session ${sessionId} for user ${session.userId}`,
      );
    }
  }

  /**
   * Cache warming - pre-populate common Q&A
   * Call this during service initialization
   */
  async initializeCacheWithCommonPrompts(): Promise<void> {
    const commonPrompts = [
      {
        prompt: 'What is blockchain?',
        response:
          'Blockchain is a distributed ledger technology that records transactions ' +
          'in a chain of blocks secured by cryptography.',
        model: 'gpt-3.5-turbo',
        ttl: 86400, // 24 hours
      },
      {
        prompt: 'How do I reset my wallet?',
        response:
          'To reset your wallet, go to Settings > Wallet > Reset. ' +
          'Make sure to back up your seed phrase first.',
        model: 'gpt-3.5-turbo',
        ttl: 86400,
      },
      {
        prompt: 'What is a smart contract?',
        response:
          'A smart contract is a self-executing contract with terms written in code ' +
          'on a blockchain, automatically executing when conditions are met.',
        model: 'gpt-3.5-turbo',
        ttl: 86400,
      },
      {
        prompt: 'Help',
        response:
          "Hello! I'm here to help. You can ask me questions about blockchain, " +
          'wallets, transactions, and more. What would you like to know?',
        model: 'gpt-3.5-turbo',
        ttl: 86400,
      },
    ];

    try {
      const count = await this.llmService.warmCache(commonPrompts);
      this.logger.log(`Warmed cache with ${count} common prompts`);
    } catch (error) {
      this.logger.error(`Failed to warm cache: ${error.message}`);
    }
  }

  /**
   * Get cache performance metrics for monitoring
   */
  async getCacheMetrics() {
    return await this.llmService.getCacheStats();
  }

  /**
   * Invalidate cache on model update
   */
  async onLlmModelUpdate(newModel: string): Promise<void> {
    this.logger.log(`Invalidating cache due to model update to ${newModel}`);
    await this.llmService.invalidateAllCache();
  }

  /**
   * Admin function: Reset user quota
   */
  async grantQuotaException(
    userId: string,
    additionalRequests: number,
  ): Promise<void> {
    const current = await this.quotaService.getUserMonthlyQuota(userId);
    await this.quotaService.setUserMonthlyQuota(
      userId,
      current + additionalRequests,
    );

    this.logger.log(
      `Granted ${additionalRequests} additional requests to user ${userId}. ` +
        `New total: ${current + additionalRequests}`,
    );
  }

  /**
   * Admin function: Prune old cache entries
   * Call periodically to manage Redis memory
   */
  async performCacheMaintenance(): Promise<void> {
    try {
      // Prune entries older than 48 hours
      const pruned = await this.llmService['cacheService'].pruneOldEntries(
        48 * 3600,
      );

      // Get stats
      const stats = await this.llmService.getCacheStats();

      this.logger.log(
        `Cache maintenance: pruned ${pruned} entries | ` +
          `Total entries: ${stats.totalEntries} | ` +
          `Hit rate: ${(stats.hitRate * 100).toFixed(2)}%`,
      );
    } catch (error) {
      this.logger.error(`Cache maintenance failed: ${error.message}`);
    }
  }
}

/**
 * Usage in Voice Gateway
 */
export class VoiceGatewayIntegration {
  constructor(private readonly voiceProcessing: VoiceProcessingService) {}

  /**
   * Handle incoming voice message
   */
  async handleVoiceMessage(
    userId: string,
    sessionId: string,
    userMessage: string,
  ) {
    // Check if user can make request
    const canRequest = await this.voiceProcessing.canUserMakeRequest(
      userId,
      sessionId,
    );

    if (!canRequest) {
      return {
        error: 'Quota exceeded',
        message: 'You have reached your monthly usage limit.',
      };
    }

    // Process message
    const result = await this.voiceProcessing.processUserPrompt(
      userId,
      sessionId,
      userMessage,
    );

    // Return response with quota info
    return {
      message: result.response,
      cached: result.cached,
      quota: {
        remaining:
          result.quotaStatus.monthlyLimit - result.quotaStatus.monthlyUsage,
        total: result.quotaStatus.monthlyLimit,
      },
      warning: result.shouldNotifyQuotaWarning
        ? 'You are approaching your monthly quota limit'
        : null,
    };
  }

  /**
   * Handle session termination
   */
  async handleSessionEnd(sessionId: string) {
    await this.voiceProcessing.terminateUserSession(sessionId);
  }

  /**
   * Get quota info for UI
   */
  async getQuotaInfo(userId: string, sessionId: string) {
    return await this.voiceProcessing.getUserQuotaInfo(userId, sessionId);
  }
}
