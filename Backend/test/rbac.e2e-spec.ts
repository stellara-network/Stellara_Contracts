import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

describe('RBAC Enforcement', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  it('should block USER from audit logs', () => {
    return request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', 'Bearer user-token')
      .expect(403);
  });

  it('should allow ADMIN to access audit logs', () => {
    return request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', 'Bearer admin-token')
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });
});
