import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from '../../audit/audit.service';
import { AuditEvent } from '../../audit/audit.event';  


export interface JwtPayload {
  sub: string; // user id
  walletId?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtAuthService {
  constructor(
    private readonly jwtService: NestJwtService,
    private readonly configService: ConfigService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly auditService: AuditService,
  
  ) {}

  async generateAccessToken(userId: string, walletId?: string): Promise<string> {
    const payload: JwtPayload = {
      sub: userId,
      walletId,
    };


    return this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION', '15m'),
    });
  }

  async generateRefreshToken(userId: string): Promise<{ token: string; id: string; expiresAt: Date }> {
    const token = uuidv4();
    const expirationDays = 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expirationDays);

    const refreshToken = this.refreshTokenRepository.create({
      token,
      userId,
      expiresAt,
      revoked: false,
    });

    const saved = await this.refreshTokenRepository.save(refreshToken);

    // Get user details for audit event
    const user = await this.userRepository.findOne({ where: { id: userId } });
    
    // Log refresh token creation
    await this.auditService.logAction('REFRESH_TOKEN_CREATED', userId, saved.id, { expiresAt: saved.expiresAt });
    

    return {
      token: saved.token,
      id: saved.id,
      expiresAt: saved.expiresAt,
    };
  }

  async validateAccessToken(token: string): Promise<JwtPayload> {
    try {
      const payload = this.jwtService.verify(token);
      return payload as JwtPayload;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; newRefreshToken: string }> {
    const tokenRecord = await this.refreshTokenRepository.findOne({
      where: { token: refreshToken },
      relations: ['user'],
    });

    if (!tokenRecord) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenRecord.revoked) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (new Date() > tokenRecord.expiresAt) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (!tokenRecord.user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    // Revoke old refresh token (token rotation)
    await this.revokeRefreshToken(tokenRecord.id);

    // Generate new tokens
    const accessToken = await this.generateAccessToken(tokenRecord.userId);
    const newRefreshTokenData = await this.generateRefreshToken(tokenRecord.userId);

    await this.auditService.logAction( 'ACCESS_TOKEN_REFRESHED', tokenRecord.userId, tokenRecord.id
);

    return {
      accessToken,
      newRefreshToken: newRefreshTokenData.token,
    };
  }

  async revokeRefreshToken(tokenId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { id: tokenId },
      {
        revoked: true,
        revokedAt: new Date(),
      },

    );

    await this.auditService.logAction('REFRESH_TOKEN_REVOKED', tokenId, tokenId
);

  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, revoked: false },
      {
        revoked: true,
        revokedAt: new Date(),
      },
    );
  }

  async getUserFromToken(token: string): Promise<User> {
    const payload = await this.validateAccessToken(token);
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    return user;
  }
}
