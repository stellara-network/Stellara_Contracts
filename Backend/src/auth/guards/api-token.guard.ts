import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiTokenService } from '../services/api-token.service';

@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(private readonly apiTokenService: ApiTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('API token required');
    }

    try {
      const tokenData = await this.apiTokenService.validateApiToken(token);
      request.user = {
        id: tokenData.userId,
        role: tokenData.role,
        tokenId: tokenData.tokenId,
      };
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid API token');
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization) {
      return undefined;
    }

    const [type, token] = authorization.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
