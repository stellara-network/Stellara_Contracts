/**
 * error-contract.e2e-spec.ts
 *
 * End-to-end tests that verify the standard error / response envelope contract
 * introduced by issue #827.
 *
 * Contract shapes verified:
 *
 * SUCCESS:
 * {
 *   "success": true,
 *   "statusCode": 200,
 *   "data": { ... },
 *   "timestamp": "<ISO-8601>",
 *   "path": "/..."
 * }
 *
 * ERROR:
 * {
 *   "success": false,
 *   "statusCode": 4xx | 5xx,
 *   "errorCode": "<SNAKE_CASE_CODE>",
 *   "message": "<human-readable>",
 *   "details": null | <any>,
 *   "timestamp": "<ISO-8601>",
 *   "path": "/..."
 * }
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../src/common/interceptors/response-envelope.interceptor';
import { HealthController } from '../src/health/health.controller';
import { DatabaseHealthIndicator } from '../src/health/database-health.indicator';
import { RedisService } from '../src/redis/redis.service';
import { StellarEventMonitorService } from '../src/stellar-monitor/services/stellar-event-monitor.service';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiError,
  ApiErrorCode,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  RateLimitError,
  WorkflowNotFoundError,
  InsufficientRoleError,
  InvalidSignatureError,
} from '../src/common/exceptions/api-error.exception';

// ─── Minimal fixture controller used only in these tests ────────────────────

@Controller('__test__')
class FixtureController {
  /** Returns a plain object – should be wrapped in success envelope */
  @Get('ok')
  ok() {
    return { hello: 'world' };
  }

  /** Returns null data – envelope should still wrap it */
  @Get('null')
  nullData() {
    return null;
  }

  /** Throws a generic ApiError */
  @Get('api-error')
  apiError() {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      ApiErrorCode.VALIDATION_ERROR,
      'Custom validation error',
      ['field must not be empty'],
    );
  }

  /** Throws a NotFoundError */
  @Get('not-found')
  notFound() {
    throw new NotFoundError('The requested resource was not found');
  }

  /** Throws a WorkflowNotFoundError */
  @Get('workflow-not-found/:id')
  workflowNotFound(@Param('id') id: string) {
    throw new WorkflowNotFoundError(id);
  }

  /** Throws an InvalidSignatureError */
  @Post('invalid-sig')
  @HttpCode(200)
  invalidSig() {
    throw new InvalidSignatureError();
  }

  /** Throws a ForbiddenError */
  @Get('forbidden')
  forbidden() {
    throw new ForbiddenError('Access denied');
  }

  /** Throws an InsufficientRoleError */
  @Get('insufficient-role')
  insufficientRole() {
    throw new InsufficientRoleError(['admin', 'superadmin'], 'user');
  }

  /** Throws a RateLimitError */
  @Get('rate-limit')
  rateLimit() {
    throw new RateLimitError(new Date(Date.now() + 60_000));
  }

  /** Throws an unhandled plain Error (should be 500) */
  @Get('unhandled')
  unhandled() {
    throw new Error('Something went terribly wrong');
  }

  /** ValidationPipe target – used to test class-validator error shape */
  @Post('validate')
  @HttpCode(200)
  validate(@Body() _body: any) {
    return { ok: true };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Assert common fields present in every error response */
function expectErrorEnvelope(
  body: any,
  expectedStatus: number,
  expectedErrorCode: string,
) {
  expect(body.success).toBe(false);
  expect(body.statusCode).toBe(expectedStatus);
  expect(body.errorCode).toBe(expectedErrorCode);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
  expect(typeof body.timestamp).toBe('string');
  // timestamp must be a valid ISO date
  expect(() => new Date(body.timestamp)).not.toThrow();
  expect(typeof body.path).toBe('string');
  expect(body.path.length).toBeGreaterThan(0);
}

/** Assert common fields present in every success response */
function expectSuccessEnvelope(body: any, expectedStatus = 200) {
  expect(body.success).toBe(true);
  expect(body.statusCode).toBe(expectedStatus);
  expect('data' in body).toBe(true);
  expect(typeof body.timestamp).toBe('string');
  expect(typeof body.path).toBe('string');
}

// ─── Test suites ────────────────────────────────────────────────────────────

describe('Error Contract — response envelope (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [FixtureController],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Apply the same pipeline as production main.ts
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Success envelope ─────────────────────────────────────────────────────

  describe('Success envelope', () => {
    it('wraps a plain object in the success envelope', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/ok')
        .expect(200);

      expectSuccessEnvelope(res.body, 200);
      expect(res.body.data).toEqual({ hello: 'world' });
      expect(res.body.path).toBe('/__test__/ok');
    });

    it('wraps null data in the success envelope', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/null')
        .expect(200);

      expectSuccessEnvelope(res.body, 200);
      expect(res.body.data).toBeNull();
    });
  });

  // ── ApiError sub-classes ─────────────────────────────────────────────────

  describe('ApiError → error envelope', () => {
    it('maps generic ApiError to correct envelope shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/api-error')
        .expect(400);

      expectErrorEnvelope(res.body, 400, 'VALIDATION_ERROR');
      expect(res.body.details).toEqual(['field must not be empty']);
    });

    it('maps NotFoundError (404) to error envelope', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/not-found')
        .expect(404);

      expectErrorEnvelope(res.body, 404, 'NOT_FOUND');
    });

    it('maps WorkflowNotFoundError (404) with typed errorCode', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/workflow-not-found/abc123')
        .expect(404);

      expectErrorEnvelope(res.body, 404, 'WORKFLOW_NOT_FOUND');
      expect(res.body.message).toContain('abc123');
    });

    it('maps InvalidSignatureError (401) to error envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/__test__/invalid-sig')
        .expect(401);

      expectErrorEnvelope(res.body, 401, 'INVALID_SIGNATURE');
    });

    it('maps ForbiddenError (403) to error envelope', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/forbidden')
        .expect(403);

      expectErrorEnvelope(res.body, 403, 'FORBIDDEN');
    });

    it('maps InsufficientRoleError (403) with INSUFFICIENT_ROLE errorCode', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/insufficient-role')
        .expect(403);

      expectErrorEnvelope(res.body, 403, 'INSUFFICIENT_ROLE');
      expect(res.body.message).toContain('admin');
      expect(res.body.message).toContain('user');
    });

    it('maps RateLimitError (429) with RATE_LIMIT_EXCEEDED errorCode', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/rate-limit')
        .expect(429);

      expectErrorEnvelope(res.body, 429, 'RATE_LIMIT_EXCEEDED');
      // details should contain retryAfter
      expect(res.body.details).toBeDefined();
      expect(res.body.details.retryAfter).toBeDefined();
    });
  });

  // ── Unhandled errors → 500 ───────────────────────────────────────────────

  describe('Unhandled error → 500 envelope', () => {
    it('returns INTERNAL_SERVER_ERROR envelope for unhandled exceptions', async () => {
      const res = await request(app.getHttpServer())
        .get('/__test__/unhandled')
        .expect(500);

      expectErrorEnvelope(res.body, 500, 'INTERNAL_SERVER_ERROR');
    });
  });

  // ── 404 for unknown routes ───────────────────────────────────────────────

  describe('Unknown route → 404 envelope', () => {
    it('returns a 404 error envelope for routes that do not exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/this-route-does-not-exist')
        .expect(404);

      expectErrorEnvelope(res.body, 404, 'NOT_FOUND');
      expect(res.body.path).toBe('/this-route-does-not-exist');
    });
  });
});

// ─── Health endpoint tests (existing, updated for envelope) ─────────────────

describe('HealthModule error envelope (e2e)', () => {
  let app: INestApplication<App>;

  const mockRedisService = { client: { ping: jest.fn() } };
  const mockStellarMonitorService = { getStatus: jest.fn() };
  const mockDatabaseHealthIndicator = {
    isHealthy: jest.fn().mockResolvedValue({ status: 'ok' }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DatabaseHealthIndicator,
          useValue: mockDatabaseHealthIndicator,
        },
        { provide: RedisService, useValue: mockRedisService },
        {
          provide: StellarEventMonitorService,
          useValue: mockStellarMonitorService,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({ status: 'ok' });
    mockRedisService.client.ping.mockResolvedValue('PONG');
    mockStellarMonitorService.getStatus.mockReturnValue({
      isMonitoring: true,
      lastLedgerSequence: 12345,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });
  });

  it('/health/live returns success envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);

    expectSuccessEnvelope(res.body, 200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.timestamp).toBeDefined();
  });

  it('/health/ready returns success envelope when all deps healthy', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expectSuccessEnvelope(res.body, 200);
    expect(res.body.data.status).toBe('ok');
  });

  it('/health/ready returns error envelope (503) when database is down', async () => {
    mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
      status: 'error',
      message: 'DB connection failed',
    });

    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);

    // Health endpoint uses ServiceUnavailableException which becomes an error envelope
    expect(res.body.success).toBe(false);
    expect(res.body.statusCode).toBe(503);
    expect(typeof res.body.timestamp).toBe('string');
  });
});
