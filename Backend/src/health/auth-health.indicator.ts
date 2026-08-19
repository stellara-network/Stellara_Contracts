import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

export interface AuthHealthCheckResult {
  status: 'ok' | 'error';
  message?: string;
  responseTimeMs?: number;
}

@Injectable()
export class AuthHealthIndicator {
  private readonly logger = new Logger(AuthHealthIndicator.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  isHealthy(): AuthHealthCheckResult {
    const start = Date.now();
    try {
      const secret = this.configService.get<string>('JWT_SECRET');
      if (!secret) {
        return {
          status: 'error',
          message: 'JWT_SECRET not configured',
          responseTimeMs: Date.now() - start,
        };
      }

      const testPayload = {
        sub: '__health_check__',
        iat: Math.floor(Date.now() / 1000),
      };
      const token = this.jwtService.sign(testPayload, { expiresIn: '1s' });
      this.jwtService.verify(token);

      return {
        status: 'ok',
        responseTimeMs: Date.now() - start,
      };
    } catch (err: any) {
      this.logger.warn(`Auth health check failed: ${err.message}`);
      return {
        status: 'error',
        message: err.message,
        responseTimeMs: Date.now() - start,
      };
    }
  }
}
