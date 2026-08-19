import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import supertest from 'supertest';

import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';
import { AuditLog, AuditLogArchive } from './audit.entity';

describe('Audit Integration', () => {
  let app: INestApplication;
  let auditService: AuditService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ envFilePath: '.env.test', isGlobal: true }),

        // Configure test database connection
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            type: 'postgres',
            host: config.get('DB_HOST'),
            port: config.get('DB_PORT'),
            username: config.get('DB_USERNAME'),
            password: config.get('DB_PASSWORD'),
            database: config.get('DB_DATABASE'),
            entities: [AuditLog, AuditLogArchive],
            synchronize: true, // Auto-create schema for tests
            logging: false,
          }),
        }),

        TypeOrmModule.forFeature([AuditLog, AuditLogArchive]),
        AuditModule,
      ],
      providers: [
        {
          // Bypass authorization checks during integration tests
          provide: APP_GUARD,
          useValue: { canActivate: () => true },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    auditService = moduleRef.get<AuditService>(AuditService);
  });

  afterAll(async () => {
    // Cleanly shut down Nest application
    await app.close();
  });

  it('should log an action and retrieve it via admin endpoint', async () => {
    // Ensure test starts with an empty audit table
    await auditService.clearAllLogs();

    // Create a test audit log entry
    await auditService.logAction('USER_CREATED', 'admin-id', 'user-123', {
      email: 'test@example.com',
    });

    // Verify audit log can be retrieved through API
    const res = await supertest(app.getHttpServer())
      .get('/admin/audit/logs')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data[0]).toHaveProperty('action_type', 'USER_CREATED');
    expect(res.body.data[0]).toHaveProperty('actor_id', 'admin-id');
  });
});
