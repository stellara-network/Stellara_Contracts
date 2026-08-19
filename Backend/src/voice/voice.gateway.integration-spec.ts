import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import io, { Socket } from 'socket.io-client';
import { VoiceModule } from './voice.module';
import { JwtService } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

describe('VoiceGateway (Integration)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let validToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: '.env.test',
          load: [
            () => ({
              JWT_SECRET: 'test-secret',
              CORS_ORIGINS: 'http://localhost:3000',
            }),
          ],
        }),
        VoiceModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    jwtService = moduleFixture.get<JwtService>(JwtService);

    await app.listen(3002);

    validToken = jwtService.sign({
      sub: 'test-user-123',
      userId: 'test-user-123',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should reject connection without token', (done) => {
    const socket = io('http://localhost:3002/voice', {
      auth: {},
      transports: ['websocket'],
    });

    socket.on('connect_error', (err) => {
      expect(err.message).toContain('Authentication');
      socket.disconnect();
      done();
    });

    socket.on('connect', () => {
      fail('Should not connect without token');
      socket.disconnect();
      done();
    });
  });

  it('should reject connection with invalid token', (done) => {
    const socket = io('http://localhost:3002/voice', {
      auth: { token: 'invalid-token' },
      transports: ['websocket'],
    });

    socket.on('connect_error', (err) => {
      expect(err.message).toContain('invalid');
      socket.disconnect();
      done();
    });

    socket.on('connect', () => {
      fail('Should not connect with invalid token');
      socket.disconnect();
      done();
    });
  });

  it('should accept connection with valid token', (done) => {
    const socket = io('http://localhost:3002/voice', {
      auth: { token: validToken },
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      expect(socket.connected).toBe(true);
      socket.disconnect();
      done();
    });

    setTimeout(() => {
      fail('Connection timeout');
      done();
    }, 5000);
  });
});
