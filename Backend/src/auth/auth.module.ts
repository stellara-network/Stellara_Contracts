import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { User } from './entities/user.entity';
import { WalletBinding } from './entities/wallet-binding.entity';
import { LoginNonce } from './entities/login-nonce.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { ApiToken } from './entities/api-token.entity';

// Services
import { NonceService } from './services/nonce.service';
import { WalletService } from './services/wallet.service';
import { JwtAuthService } from './services/jwt-auth.service';
import { ApiTokenService } from './services/api-token.service';
import { RateLimitService } from './services/rate-limit.service';

// Strategies
import { JwtStrategy } from './strategies/jwt.strategy';

// Guards
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiTokenGuard } from './guards/api-token.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { RolesGuard } from './guards/roles.guard';

// Controllers
import { AuthController } from './controllers/auth.controller';

// Import Redis Module
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      WalletBinding,
      LoginNonce,
      RefreshToken,
      ApiToken,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'default-secret-change-in-production'),
        signOptions: {
          expiresIn: configService.get('JWT_ACCESS_EXPIRATION', '15m'),
        },
      }),
      inject: [ConfigService],
    }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    ConfigModule,
    RedisModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AuthController],
  providers: [
    // Services
    NonceService,
    WalletService,
    JwtAuthService,
    ApiTokenService,
    RateLimitService,
    
    // Strategies
    JwtStrategy,
    
    // Guards
    JwtAuthGuard,
    ApiTokenGuard,
    RateLimitGuard,
    RolesGuard,
  ],
  exports: [
    JwtAuthService,
    ApiTokenService,
    WalletService,
    JwtAuthGuard,
    ApiTokenGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
