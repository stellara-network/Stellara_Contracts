import {
  CanActivate,
  ExecutionContext,
  Injectable,
  TooManyRequestsException,
} from '@nestjs/common';
import { ThrottleService } from './throttle.service';
import { RATE_LIMITS } from './throttle.constants';

@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(private readonly throttle: ThrottleService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const ip = req.ip;
    const userId = req.user?.id;
    const identifier = userId ?? ip;

    await this.throttle.checkBan(identifier);

    const isAuthRoute = req.path.includes('/auth');
    const config = isAuthRoute ? RATE_LIMITS.AUTH : RATE_LIMITS.GLOBAL;

    const key = `rate:${req.path}:${identifier}`;

    const { current, limit, ttl } =
      await this.throttle.checkRateLimit(
        key,
        config.limit,
        config.window,
      );

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - current));
    res.setHeader('X-RateLimit-Reset', ttl);

    if (current > limit) {
      await this.throttle.registerViolation(identifier);
      throw new TooManyRequestsException('Rate limit exceeded');
    }

    return true;
  }
}
