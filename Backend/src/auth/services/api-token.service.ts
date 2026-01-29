import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiToken } from '../entities/api-token.entity';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ApiTokenService {
  private readonly SALT_ROUNDS = 10;

  constructor(
    @InjectRepository(ApiToken)
    private readonly apiTokenRepository: Repository<ApiToken>,
    private readonly configService: ConfigService,
  ) {}

  async createApiToken(
    userId: string,
    name: string,
    role: string,
    expiresInDays?: number,
  ): Promise<{ token: string; id: string; expiresAt: Date | null }> {
    // Generate a secure random token
    const plainToken = `stl_${uuidv4()}${uuidv4()}`.replace(/-/g, '');
    
    // Hash the token for storage
    const hashedToken = await bcrypt.hash(plainToken, this.SALT_ROUNDS);

    // Calculate expiration
    let expiresAt: Date | null = null;
    if (expiresInDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    } else {
      const defaultDays = this.configService.get('API_TOKEN_DEFAULT_EXPIRY_DAYS', 90);
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + defaultDays);
    }

    const apiToken = this.apiTokenRepository.create({
      token: hashedToken,
      name,
      role,
      userId,
      expiresAt,
      revoked: false,
    });

    const saved = await this.apiTokenRepository.save(apiToken);

    // Return the plain token only once - it won't be stored
    return {
      token: plainToken,
      id: saved.id,
      expiresAt: saved.expiresAt,
    };
  }

  async validateApiToken(plainToken: string): Promise<{ userId: string; role: string; tokenId: string }> {
    // Get all non-revoked, non-expired tokens
    const tokens = await this.apiTokenRepository.find({
      where: { revoked: false },
      relations: ['user'],
    });

    // Check each token against the plain token
    for (const tokenRecord of tokens) {
      const isMatch = await bcrypt.compare(plainToken, tokenRecord.token);
      
      if (isMatch) {
        // Check expiration
        if (tokenRecord.expiresAt && new Date() > tokenRecord.expiresAt) {
          throw new UnauthorizedException('API token expired');
        }

        // Check if user is active
        if (!tokenRecord.user.isActive) {
          throw new UnauthorizedException('User account is inactive');
        }

        // Update last used timestamp
        await this.apiTokenRepository.update(
          { id: tokenRecord.id },
          { lastUsedAt: new Date() },
        );

        return {
          userId: tokenRecord.userId,
          role: tokenRecord.role,
          tokenId: tokenRecord.id,
        };
      }
    }

    throw new UnauthorizedException('Invalid API token');
  }

  async revokeApiToken(tokenId: string, userId: string): Promise<void> {
    const token = await this.apiTokenRepository.findOne({
      where: { id: tokenId, userId },
    });

    if (!token) {
      throw new NotFoundException('API token not found');
    }

    await this.apiTokenRepository.update(
      { id: tokenId },
      { revoked: true },
    );
  }

  async listUserApiTokens(userId: string): Promise<ApiToken[]> {
    return await this.apiTokenRepository.find({
      where: { userId },
      select: ['id', 'name', 'role', 'expiresAt', 'revoked', 'lastUsedAt', 'createdAt'],
      order: { createdAt: 'DESC' },
    });
  }

  async revokeAllUserApiTokens(userId: string): Promise<void> {
    await this.apiTokenRepository.update(
      { userId, revoked: false },
      { revoked: true },
    );
  }
}
