import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtAuthGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    const token = this.extractTokenFromHandshake(client);

    if (!token) {
      this.logger.warn(
        `WebSocket connection rejected: No token provided from ${client.id}`,
      );
      throw new UnauthorizedException('Authentication token required');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      client.data.user = payload;
      this.logger.log(
        `WebSocket authenticated: ${payload.sub || payload.userId || 'unknown'}`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `WebSocket connection rejected: Invalid token from ${client.id}`,
      );
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractTokenFromHandshake(client: Socket): string | null {
    const authToken = client.handshake.auth?.token;
    if (authToken) return authToken;

    const authHeader = client.handshake.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    const queryToken = client.handshake.query?.token as string;
    if (queryToken) return queryToken;

    return null;
  }
}
