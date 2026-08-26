import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { SecretsRotationHandlerService, RotationResult } from '../secrets-rotation-handler.service';
import { RotateSecretDto } from '../dto/rotate-secret.dto';
import { SecretsMaskingService } from '../secrets-masking.service';

// Type for optional audit service
interface IAuditService {
  logAction(action_type: string, actor_id: string, entity_id?: string, metadata?: Record<string, any>): Promise<any>;
}

/**
 * SecretsController
 *
 * Provides endpoints for runtime secret rotation and management.
 * These endpoints are restricted to administrators and operators only.
 */
@ApiTags('Secrets Management')
@Controller('secrets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SecretsController {
  private readonly ADMIN_ROLE = 'admin';

  constructor(
    private readonly rotationHandlerService: SecretsRotationHandlerService,
    private readonly maskingService: SecretsMaskingService,
    @Inject('AuditService') @Optional() private readonly auditService?: IAuditService,
  ) {}

  /**
   * Verify that the requesting user has admin privileges.
   */
  private verifyAdminAccess(request: any): void {
    const user = request.user;
    if (!user || user.role !== this.ADMIN_ROLE) {
      throw new ForbiddenException(
        'Secrets rotation is restricted to administrators only',
      );
    }
  }

  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a secret at runtime',
    description: 'Validates and applies a new secret value with full audit logging. Requires admin role.',
  })
  @ApiBody({ type: RotateSecretDto })
  @ApiResponse({
    status: 200,
    description: 'Secret rotated successfully',
    schema: {
      properties: {
        success: { type: 'boolean', example: true },
        statusCode: { type: 'number', example: 200 },
        data: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            secretKey: { type: 'string', example: 'JWT_SECRET' },
            rotatedAt: { type: 'string', format: 'date-time' },
            reason: { type: 'string', example: 'manual' },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed - new secret value does not meet requirements',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - authentication required',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - admin role required',
  })
  async rotateSecret(@Body() dto: RotateSecretDto, @Request() req) {
    // Verify admin access
    this.verifyAdminAccess(req);

    // Use user ID as actor for audit logging
    const actorId = req.user.id || 'unknown';

    // Perform the rotation
    const result = await this.rotationHandlerService.rotateSecret(dto, actorId);

    // Return result without sensitive oldValue
    const { oldValue, ...safeResult } = result;
    return safeResult;
  }

  @Get('rotatable')
  @ApiOperation({
    summary: 'List rotatable secrets',
    description: 'Returns a list of secrets that can be rotated at runtime with their validation rules. Requires admin role.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of rotatable secrets retrieved',
    schema: {
      properties: {
        success: { type: 'boolean', example: true },
        statusCode: { type: 'number', example: 200 },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', example: 'JWT_SECRET' },
              description: { type: 'string', example: 'JWT signing key for access token generation' },
              validationRule: { type: 'string', example: 'must be at least 32 characters' },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - authentication required',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - admin role required',
  })
  async listRotatableSecrets(@Request() req) {
    // Verify admin access
    this.verifyAdminAccess(req);

    const secrets = this.rotationHandlerService.getRotatableSecrets();
    return secrets;
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get secrets management status',
    description: 'Returns information about the current secrets management configuration and registered rotation handlers. Requires admin role.',
  })
  @ApiResponse({
    status: 200,
    description: 'Secrets management status retrieved',
    schema: {
      properties: {
        success: { type: 'boolean', example: true },
        statusCode: { type: 'number', example: 200 },
        data: {
          type: 'object',
          properties: {
            maskingEnabled: { type: 'boolean', example: true },
            rotationEnabled: { type: 'boolean', example: true },
            registeredHandlers: { type: 'array', items: { type: 'string' } },
            environment: { type: 'string', example: 'production' },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - authentication required',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - admin role required',
  })
  async getStatus(@Request() req) {
    // Verify admin access
    this.verifyAdminAccess(req);

    // Return basic status information
    return {
      maskingEnabled: true,
      rotationEnabled: true,
      registeredHandlers: [], // Would be populated by rotation service
      environment: process.env.NODE_ENV || 'unknown',
    };
  }
}
