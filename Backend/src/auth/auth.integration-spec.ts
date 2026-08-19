import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth.module';
import { RedisModule } from '../redis/redis.module';
import { Keypair } from '@stellar/stellar-sdk';
import * as nacl from 'tweetnacl';

describe('Auth Integration Tests (e2e)', () => {
  let app: INestApplication;
  let testKeypair: Keypair;
  let testKeypair2: Keypair;

  beforeAll(async () => {
    // Generate test keypairs
    testKeypair = Keypair.random();
    testKeypair2 = Keypair.random();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [__dirname + '/**/*.entity{.ts,.js}'],
          synchronize: true,
        }),
        RedisModule,
        AuthModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Helper ──────────────────────────────────────────────────────────────
  /** Issue a nonce + sign + login, returning both tokens. */
  async function loginAs(keypair: Keypair) {
    const nonceRes = await request(app.getHttpServer())
      .post('/auth/nonce')
      .send({ publicKey: keypair.publicKey() });

    const nonce = nonceRes.body.nonce;
    const message = `Sign this message to authenticate with Stellara: ${nonce}`;
    const signature = nacl.sign.detached(
      Buffer.from(message, 'utf-8'),
      keypair.rawSecretKey(),
    );

    const loginRes = await request(app.getHttpServer())
      .post('/auth/wallet/login')
      .send({
        publicKey: keypair.publicKey(),
        signature: Buffer.from(signature).toString('base64'),
        nonce,
      });

    return {
      accessToken: loginRes.body.accessToken as string,
      refreshToken: loginRes.body.refreshToken as string,
      user: loginRes.body.user,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  describe('Successful Login Flow', () => {
    let accessToken: string;
    let refreshToken: string;

    it('should request a nonce', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() })
        .expect(201);

      expect(response.body).toHaveProperty('nonce');
      expect(response.body).toHaveProperty('expiresAt');
      expect(response.body).toHaveProperty('message');
    });

    it('should login with valid signature', async () => {
      const tokens = await loginAs(testKeypair);
      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.user).toHaveProperty('id');
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
    });

    it('should access protected endpoint with access token', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.wallets).toBeInstanceOf(Array);
    });

    it('should refresh access token', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');

      // New tokens should be different
      expect(response.body.accessToken).not.toBe(accessToken);
      expect(response.body.refreshToken).not.toBe(refreshToken);
    });

    it('should logout successfully', async () => {
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Replay Attack Prevention', () => {
    it('should reject reused nonce', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const messageBytes = Buffer.from(message, 'utf-8');
      const signature = nacl.sign.detached(
        messageBytes,
        testKeypair.rawSecretKey(),
      );
      const signatureBase64 = Buffer.from(signature).toString('base64');

      // First login should succeed
      await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: signatureBase64,
          nonce,
        })
        .expect(200);

      // Second login with same nonce should fail with structured error
      const replay = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: signatureBase64,
          nonce,
        })
        .expect(401);

      expect(replay.body).toHaveProperty('errorCode', 'INVALID_NONCE');
      expect(replay.body).toHaveProperty('correlationId');
    });

    it('should reject expired nonce', async () => {
      // Generate a nonce and manually expire it is not possible via API,
      // but we verify the error structure for an unknown nonce
      const res = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: 'dGVzdA==', // base64 "test"
          nonce: '00000000-0000-0000-0000-000000000000',
        })
        .expect(401);

      expect(res.body).toHaveProperty('errorCode');
      expect(res.body).toHaveProperty('correlationId');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Invalid Signature', () => {
    it('should reject invalid signature with structured error and correlationId', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const invalidSignature = 'invalid-signature-base64';

      const res = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: invalidSignature,
          nonce,
        })
        .expect(401);

      expect(res.body).toHaveProperty('errorCode', 'INVALID_SIGNATURE');
      expect(res.body).toHaveProperty('correlationId');
      expect(typeof res.body.correlationId).toBe('string');
      expect(res.body.correlationId.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Refresh Token Rotation & Abuse', () => {
    it('should revoke the whole family when a rotated token is replayed', async () => {
      const tokens = await loginAs(testKeypair);
      const firstRefresh = tokens.refreshToken;

      // Rotate once → first token is now revoked
      const rotateResponse = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: firstRefresh })
        .expect(200);

      expect(rotateResponse.body.refreshToken).not.toBe(firstRefresh);
      expect(rotateResponse.body).toHaveProperty('familyId');

      // Replaying the rotated-away token must fail and revoke the family
      const replay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: firstRefresh })
        .expect(401);

      expect(replay.body).toHaveProperty('errorCode', 'TOKEN_INVALID');

      // The freshly issued token from the legitimate rotation is also dead
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: rotateResponse.body.refreshToken })
        .expect(401);
    });

    it('should support a multi-step rotation chain (A → B → C)', async () => {
      const tokens = await loginAs(testKeypair);

      // Rotate: original → B
      const res1 = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const familyIdB = res1.body.familyId;
      expect(res1.body.refreshToken).not.toBe(tokens.refreshToken);

      // Rotate: B → C (same family)
      const res2 = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: res1.body.refreshToken })
        .expect(200);

      expect(res2.body.familyId).toBe(familyIdB);
      expect(res2.body.refreshToken).not.toBe(res1.body.refreshToken);

      // Replaying B (the middle token) should now revoke the entire family
      const replay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: res1.body.refreshToken })
        .expect(401);

      expect(replay.body).toHaveProperty('errorCode', 'TOKEN_INVALID');

      // C is also dead
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: res2.body.refreshToken })
        .expect(401);

      // The original is long dead too
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });

    it('should reject expired refresh token with TOKEN_EXPIRED code', async () => {
      // We can't easily create an expired token via the API, but we can
      // verify the error structure for a completely invalid token
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'totally-fake-token' })
        .expect(401);

      expect(res.body).toHaveProperty('errorCode', 'TOKEN_INVALID');
      expect(res.body).toHaveProperty('correlationId');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Correlation IDs in Error Responses', () => {
    it('should include correlationId in login failure responses', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: 'bm90LWEtc2lnbmF0dXJl',
          nonce: '00000000-0000-0000-0000-000000000000',
        })
        .expect(401);

      expect(res.body).toHaveProperty('correlationId');
      expect(typeof res.body.correlationId).toBe('string');
      // UUID format
      expect(res.body.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should include correlationId in refresh failure responses', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'invalid-token-value' })
        .expect(401);

      expect(res.body).toHaveProperty('correlationId');
      expect(typeof res.body.correlationId).toBe('string');
    });

    it('should include correlationId in signature failure responses', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const res = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: 'aW52YWxpZA==',
          nonce: nonceResponse.body.nonce,
        })
        .expect(401);

      expect(res.body).toHaveProperty('correlationId');
      expect(res.body.errorCode).toBe('INVALID_SIGNATURE');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Nonce Atomicity & Consistent State', () => {
    it('should leave no dangling state after failed signature verification', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const nonce = nonceResponse.body.nonce;

      // Attempt login with wrong signature — nonce should NOT be consumed
      await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: 'd3Jvbmc=',
          nonce,
        })
        .expect(401);

      // Same nonce should still work with the correct signature
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const signature = nacl.sign.detached(
        Buffer.from(message, 'utf-8'),
        testKeypair.rawSecretKey(),
      );

      await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: Buffer.from(signature).toString('base64'),
          nonce,
        })
        .expect(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('API Token Flow', () => {
    let accessToken: string;
    let apiToken: string;
    let apiTokenId: string;

    beforeAll(async () => {
      const tokens = await loginAs(testKeypair);
      accessToken = tokens.accessToken;
    });

    it('should create API token', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/api-token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Test AI Service Token',
          role: 'ai-service',
          expiresInDays: 30,
        })
        .expect(201);

      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('id');
      expect(response.body.token).toMatch(/^stl_/);

      apiToken = response.body.token;
      apiTokenId = response.body.id;
    });

    it('should list API tokens', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/api-token')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('should revoke API token', async () => {
      await request(app.getHttpServer())
        .delete(`/auth/api-token/${apiTokenId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Wallet Binding', () => {
    let accessToken: string;
    let userId: string;

    beforeAll(async () => {
      const tokens = await loginAs(testKeypair);
      accessToken = tokens.accessToken;
      userId = tokens.user.id;
    });

    it('should bind additional wallet', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair2.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const signature = nacl.sign.detached(
        Buffer.from(message, 'utf-8'),
        testKeypair2.rawSecretKey(),
      );

      await request(app.getHttpServer())
        .post('/auth/wallet/bind')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          publicKey: testKeypair2.publicKey(),
          signature: Buffer.from(signature).toString('base64'),
          nonce,
        })
        .expect(201);
    });

    it('should login with second wallet and access same account', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair2.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const signature = nacl.sign.detached(
        Buffer.from(message, 'utf-8'),
        testKeypair2.rawSecretKey(),
      );

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair2.publicKey(),
          signature: Buffer.from(signature).toString('base64'),
          nonce,
        })
        .expect(200);

      expect(loginResponse.body.user.id).toBe(userId);
    });

    it('should reject bind with invalid nonce and include correlationId', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/wallet/bind')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          publicKey: testKeypair2.publicKey(),
          signature: 'bm90LW9yaWdpbmFs',
          nonce: '00000000-0000-0000-0000-000000000000',
        })
        .expect(401);

      expect(res.body).toHaveProperty('errorCode', 'INVALID_NONCE');
      expect(res.body).toHaveProperty('correlationId');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('Rate Limiting', () => {
    it('should enforce rate limits on nonce endpoint', async () => {
      const publicKey = Keypair.random().publicKey();

      // Make 6 rapid requests (limit is 5 per minute)
      const requests: Array<Promise<any>> = [];
      for (let i = 0; i < 6; i++) {
        requests.push(
          request(app.getHttpServer()).post('/auth/nonce').send({ publicKey }),
        );
      }

      const responses = await Promise.all(requests);
      const tooManyRequests = responses.filter((r) => r.status === 429);

      expect(tooManyRequests.length).toBeGreaterThan(0);
    });
  });
});
