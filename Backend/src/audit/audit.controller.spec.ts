import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { Role } from '../auth/roles.enum';

describe('AuditController (Admin)', () => {
  let controller: AuditController;
  let auditService: AuditService;

  const mockAuditService = {
    getLogs: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
      ],
    }).compile();

    controller = module.get<AuditController>(AuditController);
    auditService = module.get<AuditService>(AuditService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should allow admin to get logs', async () => {
    const logsMock = {
      data: [
        { action_type: 'USER_CREATED', actor_id: '1', entity_id: '1', metadata: {} },
      ],
      total: 1,
    };
    mockAuditService.getLogs.mockResolvedValue(logsMock);

    const req = { user: { role: Role.ADMIN } }; // simulate admin user

    const result = await controller.getLogs(1, 10);
    expect(result).toEqual(logsMock);
    expect(auditService.getLogs).toHaveBeenCalledWith(
      1,
      10,
      { action_type: undefined, actor_id: undefined, entity_id: undefined, from: undefined, to: undefined },
    );
  });

  it('should throw ForbiddenException for non-admin', async () => {
    const req = { user: { role: Role.USER } }; // simulate non-admin
    try {
      await controller.getLogs(1, 10);
    } catch (e) {
      expect(e.response).toBeDefined();
      expect(e.status).toBe(403);
    }
  });
});
