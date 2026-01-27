import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { NonceService } from '../services/nonce.service';
import { WalletService } from '../services/wallet.service';
import { JwtAuthService } from '../services/jwt-auth.service';
import { ApiTokenService } from '../services/api-token.service';
import { RequestNonceDto } from '../dto/request-nonce.dto';
import { WalletLoginDto } from '../dto/wallet-login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { CreateApiTokenDto } from '../dto/create-api-token.dto';
import { BindWalletDto } from '../dto/bind-wallet.dto';
import { UnbindWalletDto } from '../dto/unbind-wallet.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';

@ApiTags('Authentication')
@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    private readonly nonceService: NonceService,
    private readonly walletService: WalletService,
    private readonly jwtAuthService: JwtAuthService,
    private readonly apiTokenService: ApiTokenService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService, 
  ) {}

  @Post('nonce')
  @RateLimit({ limit: 5, windowSeconds: 60, keyPrefix: 'nonce' })
  @ApiOperation({ summary: 'Request a nonce for wallet authentication' })
  @ApiBody({ type: RequestNonceDto })
  @ApiResponse({
    status: 200,
    description: 'Nonce generated successfully',
    schema: {
      properties: {
        nonce: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async requestNonce(@Body() dto: RequestNonceDto) {
    return await this.nonceService.generateNonce(dto.publicKey);
  }

  @Post('wallet/login')
  @RateLimit({ limit: 5, windowSeconds: 60, keyPrefix: 'login' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with wallet signature' })
  @ApiBody({ type: WalletLoginDto })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    schema: {
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', nullable: true },
            username: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid signature or nonce' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async walletLogin(@Body() dto: WalletLoginDto) {
    // Validate nonce
    const nonceRecord = await this.nonceService.validateNonce(
      dto.nonce,
      dto.publicKey,
    );

    // Construct message to verify
    const message = `Sign this message to authenticate with Stellara: ${dto.nonce}`;

    // Verify signature
    const isValid = await this.walletService.verifySignature(
      dto.publicKey,
      dto.signature,
      message,
    );

    if (!isValid) {
      throw new Error('Invalid signature');
    }

    // Mark nonce as used
    await this.nonceService.markNonceUsed(dto.nonce);

    // Find or create user
    let user = await this.walletService.findUserByWallet(dto.publicKey);

    // if (!user) {
    //   user = await this.walletService.createUserWithWallet(dto.publicKey);
    // }

    let isNewUser = false;

    if (!user) {
     user = await this.walletService.createUserWithWallet(dto.publicKey);
     isNewUser = true;
  }

     if (isNewUser) {await this.auditService.logAction(  'USER_CREATED',  user.id,  user.id,
      { wallet: dto.publicKey }
    );
}


    // Update wallet last used
    await this.walletService.updateLastUsed(dto.publicKey);

    // Generate tokens
    const accessToken = await this.jwtAuthService.generateAccessToken(user.id);
    const refreshTokenData =
      await this.jwtAuthService.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken: refreshTokenData.token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        createdAt: user.createdAt,
      },
    };
  }

  @Post('refresh')
  @RateLimit({ limit: 10, windowSeconds: 60, keyPrefix: 'refresh' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({
    status: 200,
    description: 'Token refreshed successfully',
    schema: {
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async refreshToken(@Body() dto: RefreshTokenDto) {
    const tokens = await this.jwtAuthService.refreshAccessToken(
      dto.refreshToken,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.newRefreshToken,
    };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and revoke refresh tokens' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@Request() req) {
    await this.jwtAuthService.revokeAllUserRefreshTokens(req.user.id);
    return { message: 'Logged out successfully' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user information' })
  @ApiResponse({
    status: 200,
    description: 'User information retrieved',
    schema: {
      properties: {
        id: { type: 'string' },
        email: { type: 'string', nullable: true },
        username: { type: 'string', nullable: true },
        isActive: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        wallets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              publicKey: { type: 'string' },
              isPrimary: { type: 'boolean' },
              lastUsed: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@Request() req) {
    return req.user;
  }

  @Post('wallet/bind')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bind additional wallet to account' })
  @ApiBody({ type: BindWalletDto })
  @ApiResponse({ status: 201, description: 'Wallet bound successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Wallet already bound' })
  async bindWallet(@Request() req, @Body() dto: BindWalletDto) {
    // Validate nonce
    await this.nonceService.validateNonce(dto.nonce, dto.publicKey);

    // Construct message to verify
    const message = `Sign this message to authenticate with Stellara: ${dto.nonce}`;

    // Verify signature
    const isValid = await this.walletService.verifySignature(
      dto.publicKey,
      dto.signature,
      message,
    );

    if (!isValid) {
      throw new Error('Invalid signature');
    }

    // Mark nonce as used
    await this.nonceService.markNonceUsed(dto.nonce);

    // Bind wallet
    const binding = await this.walletService.bindWalletToUser(
      dto.publicKey,
      req.user.id,
      false,
    );

    return {
      message: 'Wallet bound successfully',
      wallet: {
        id: binding.id,
        publicKey: binding.publicKey,
        isPrimary: binding.isPrimary,
      },
    };
  }

  @Delete('wallet/unbind')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unbind wallet from account' })
  @ApiBody({ type: UnbindWalletDto })
  @ApiResponse({ status: 200, description: 'Wallet unbound successfully' })
  @ApiResponse({ status: 400, description: 'Cannot unbind the only wallet' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async unbindWallet(@Request() req, @Body() dto: UnbindWalletDto) {
    await this.walletService.unbindWallet(dto.publicKey, req.user.id);
    return { message: 'Wallet unbound successfully' };
  }

  @Post('api-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create API token for services' })
  @ApiBody({ type: CreateApiTokenDto })
  @ApiResponse({
    status: 201,
    description: 'API token created successfully (token shown only once)',
    schema: {
      properties: {
        token: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async createApiToken(@Request() req, @Body() dto: CreateApiTokenDto) {
    const tokenData = await this.apiTokenService.createApiToken(
      req.user.id,
      dto.name,
      dto.role,
      dto.expiresInDays,
    );

    return {
      token: tokenData.token,
      id: tokenData.id,
      name: dto.name,
      role: dto.role,
      expiresAt: tokenData.expiresAt,
      warning: 'Save this token securely. It will not be shown again.',
    };
  }

  @Get('api-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List user API tokens' })
  @ApiResponse({
    status: 200,
    description: 'API tokens retrieved',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          revoked: { type: 'boolean' },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listApiTokens(@Request() req) {
    return await this.apiTokenService.listUserApiTokens(req.user.id);
  }

  @Delete('api-token/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke API token' })
  @ApiResponse({ status: 200, description: 'API token revoked successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'API token not found' })
  async revokeApiToken(@Request() req, @Param('id') tokenId: string) {
    await this.apiTokenService.revokeApiToken(tokenId, req.user.id);
    return { message: 'API token revoked successfully' };
  }
}
