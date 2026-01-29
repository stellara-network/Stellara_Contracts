import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
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
          type: 'sqlite',
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

  describe('Successful Login Flow', () => {
    let accessToken: string;
    let refreshToken: string;
    let nonce: string;

    it('should request a nonce', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() })
        .expect(201);

      expect(response.body).toHaveProperty('nonce');
      expect(response.body).toHaveProperty('expiresAt');
      expect(response.body).toHaveProperty('message');
      nonce = response.body.nonce;
    });

    it('should login with valid signature', async () => {
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const messageBytes = Buffer.from(message, 'utf-8');
      const secretKey = testKeypair.rawSecretKey();
      const signature = nacl.sign.detached(messageBytes, secretKey);
      const signatureBase64 = Buffer.from(signature).toString('base64');

      const response = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: signatureBase64,
          nonce,
        })
        .expect(200);

      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('id');

      accessToken = response.body.accessToken;
      refreshToken = response.body.refreshToken;
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

  describe('Replay Attack Prevention', () => {
    it('should reject reused nonce', async () => {
      // Request nonce
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

      // Second login with same nonce should fail
      await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: signatureBase64,
          nonce,
        })
        .expect(401);
    });
  });

  describe('Invalid Signature', () => {
    it('should reject invalid signature', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const invalidSignature = 'invalid-signature-base64';

      await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: invalidSignature,
          nonce,
        })
        .expect(500);
    });
  });

  describe('API Token Flow', () => {
    let accessToken: string;
    let apiToken: string;
    let apiTokenId: string;

    beforeAll(async () => {
      // Login first
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const signature = nacl.sign.detached(
        Buffer.from(message, 'utf-8'),
        testKeypair.rawSecretKey(),
      );

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: Buffer.from(signature).toString('base64'),
          nonce,
        });

      accessToken = loginResponse.body.accessToken;
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

  describe('Wallet Binding', () => {
    let accessToken: string;
    let userId: string;

    beforeAll(async () => {
      // Login with first wallet
      const nonceResponse = await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ publicKey: testKeypair.publicKey() });

      const nonce = nonceResponse.body.nonce;
      const message = `Sign this message to authenticate with Stellara: ${nonce}`;
      const signature = nacl.sign.detached(
        Buffer.from(message, 'utf-8'),
        testKeypair.rawSecretKey(),
      );

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/wallet/login')
        .send({
          publicKey: testKeypair.publicKey(),
          signature: Buffer.from(signature).toString('base64'),
          nonce,
        });

      accessToken = loginResponse.body.accessToken;
      userId = loginResponse.body.user.id;
    });

    it('should bind additional wallet', async () => {
      // Get nonce for second wallet
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
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits on nonce endpoint', async () => {
      const publicKey = Keypair.random().publicKey();

      // Make 6 rapid requests (limit is 5 per minute)
      const requests = [];
      for (let i = 0; i < 6; i++) {
        requests.push(
          request(app.getHttpServer())
            .post('/auth/nonce')
            .send({ publicKey }),
        );
      }

      const responses = await Promise.all(requests);
      const tooManyRequests = responses.filter(
        (r) => r.status === 429,
      );

      expect(tooManyRequests.length).toBeGreaterThan(0);
    });
  });
});
