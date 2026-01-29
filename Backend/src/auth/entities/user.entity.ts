import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { WalletBinding } from './wallet-binding.entity';
import { RefreshToken } from './refresh-token.entity';
import { ApiToken } from './api-token.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, nullable: true })
  email?: string;

  @Column({ nullable: true })
  username?: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  @Column({ default: true })
  isActive: boolean;

  @OneToMany(() => WalletBinding, (binding) => binding.user)
  wallets: WalletBinding[];

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens: RefreshToken[];

  @OneToMany(() => ApiToken, (token) => token.user)
  apiTokens: ApiToken[];
}
