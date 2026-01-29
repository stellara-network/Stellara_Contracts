import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletBinding } from '../entities/wallet-binding.entity';
import { User } from '../entities/user.entity';
import * as nacl from 'tweetnacl';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(WalletBinding)
    private readonly walletBindingRepository: Repository<WalletBinding>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async verifySignature(publicKey: string, signature: string, message: string): Promise<boolean> {
    try {
      // Decode the Stellar public key to raw bytes
      const publicKeyBytes = StrKey.decodeEd25519PublicKey(publicKey);
      
      // Decode the signature from base64
      const signatureBytes = Buffer.from(signature, 'base64');
      
      // Convert message to bytes
      const messageBytes = Buffer.from(message, 'utf-8');
      
      // Verify signature using tweetnacl
      const isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes,
      );

      return isValid;
    } catch (error) {
      console.error('Signature verification error:', error);
      return false;
    }
  }

  async findUserByWallet(publicKey: string): Promise<User | null> {
    const binding = await this.walletBindingRepository.findOne({
      where: { publicKey },
      relations: ['user'],
    });

    return binding?.user || null;
  }

  async bindWalletToUser(publicKey: string, userId: string, isPrimary: boolean = false): Promise<WalletBinding> {
    // Check if wallet is already bound
    const existingBinding = await this.walletBindingRepository.findOne({
      where: { publicKey },
    });

    if (existingBinding) {
      throw new ConflictException('Wallet already bound to an account');
    }

    // If this is a primary wallet, set all other wallets to non-primary
    if (isPrimary) {
      await this.walletBindingRepository.update(
        { userId },
        { isPrimary: false },
      );
    }

    const binding = this.walletBindingRepository.create({
      publicKey,
      userId,
      isPrimary,
      lastUsed: new Date(),
    });

    return await this.walletBindingRepository.save(binding);
  }

  async unbindWallet(publicKey: string, userId: string): Promise<void> {
    const binding = await this.walletBindingRepository.findOne({
      where: { publicKey, userId },
    });

    if (!binding) {
      throw new BadRequestException('Wallet not found or not owned by user');
    }

    // Check if this is the only wallet
    const userWalletCount = await this.walletBindingRepository.count({
      where: { userId },
    });

    if (userWalletCount === 1) {
      throw new BadRequestException('Cannot unbind the only wallet. Account must have at least one wallet.');
    }

    await this.walletBindingRepository.remove(binding);

    // If it was primary, make another wallet primary
    if (binding.isPrimary) {
      const anotherWallet = await this.walletBindingRepository.findOne({
        where: { userId },
      });

      if (anotherWallet) {
        anotherWallet.isPrimary = true;
        await this.walletBindingRepository.save(anotherWallet);
      }
    }
  }

  async updateLastUsed(publicKey: string): Promise<void> {
    await this.walletBindingRepository.update(
      { publicKey },
      { lastUsed: new Date() },
    );
  }

  async createUserWithWallet(publicKey: string): Promise<User> {
    const user = this.userRepository.create({
      isActive: true,
    });

    const savedUser = await this.userRepository.save(user);

    await this.bindWalletToUser(publicKey, savedUser.id, true);

    return savedUser;
  }
}
