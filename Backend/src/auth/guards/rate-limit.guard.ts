import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService } from '../services/rate-limit.service';
import { RateLimitError } from '../../common/exceptions/api-error.exception';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  keyPrefix?: string;
}

export const RateLimit = (options: RateLimitOptions) => {
  return (
    target: any,
    propertyKey?: string,
    descriptor?: PropertyDescriptor,
  ) => {
    if (propertyKey && descriptor) {
      Reflect.defineMetadata(RATE_LIMIT_KEY, options, descriptor.value);
      return descriptor;
    }
    Reflect.defineMetadata(RATE_LIMIT_KEY, options, target);
    return target;
  };
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );

    if (!options) {
      return true; // No rate limit configured
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Securely extract the client identifier string
    const ip = request.ip || request.connection?.remoteAddress || 'unknown';

    // Establish the target route or function namespace identifier
    const keyPrefix =
      options.keyPrefix || request.route?.path || context.getHandler().name;

    // Execute atomic validation check matching the service signature: (ip, route, limit, windowSeconds)
    const result = await this.rateLimitService.checkRateLimit(
      ip,
      keyPrefix,
      options.limit,
      options.windowSeconds,
    );

    // Explicitly set string values on tracking header fields to satisfy HTTP specs
    response.setHeader('X-RateLimit-Limit', options.limit.toString());
    response.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    response.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());

    if (!result.allowed) {
      throw new RateLimitError(result.resetAt);
    }

    return true;
  }
}
