import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { LoginNonce } from '../entities/login-nonce.entity';
import { v4 as uuidv4 } from 'uuid';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class NonceService {
  private readonly NONCE_EXPIRATION_MINUTES = 5;

  constructor(
    @InjectRepository(LoginNonce)
    private readonly nonceRepository: Repository<LoginNonce>,
  ) {}

  async generateNonce(publicKey: string): Promise<{ nonce: string; expiresAt: Date; message: string }> {
    const nonce = uuidv4();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.NONCE_EXPIRATION_MINUTES);

    const loginNonce = this.nonceRepository.create({
      nonce,
      publicKey,
      expiresAt,
      used: false,
    });

    await this.nonceRepository.save(loginNonce);

    const message = `Sign this message to authenticate with Stellara: ${nonce}`;

    return {
      nonce,
      expiresAt,
      message,
    };
  }

  async validateNonce(nonce: string, publicKey: string): Promise<LoginNonce> {
    const loginNonce = await this.nonceRepository.findOne({
      where: { nonce, publicKey },
    });

    if (!loginNonce) {
      throw new UnauthorizedException('Invalid nonce');
    }

    if (loginNonce.used) {
      throw new UnauthorizedException('Nonce already used');
    }

    if (new Date() > loginNonce.expiresAt) {
      throw new UnauthorizedException('Nonce expired');
    }

    return loginNonce;
  }

  async markNonceUsed(nonce: string): Promise<void> {
    await this.nonceRepository.update({ nonce }, { used: true });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredNonces(): Promise<void> {
    const now = new Date();
    await this.nonceRepository.delete({
      expiresAt: LessThan(now),
    });
  }
}
