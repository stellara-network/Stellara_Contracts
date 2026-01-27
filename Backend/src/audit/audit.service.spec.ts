import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog } from './audit.entity';

describe('AuditService', () => {
  let service: AuditService;
  let repo: Repository<AuditLog>;

  const mockRepo = {
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
    repo = module.get<Repository<AuditLog>>(getRepositoryToken(AuditLog));
  });

  it('should log an action', async () => {
    const log = { id: '1', action_type: 'USER_CREATED' };
    mockRepo.create.mockReturnValue(log);
    mockRepo.save.mockResolvedValue(log);

    const result = await service.logAction('USER_CREATED', 'user1', 'entity1', { key: 'value' });

    expect(mockRepo.create).toHaveBeenCalledWith({
      action_type: 'USER_CREATED',
      actor_id: 'user1',
      entity_id: 'entity1',
      metadata: { key: 'value' },
    });
    expect(mockRepo.save).toHaveBeenCalledWith(log);
    expect(result).toEqual(log);
  });

  it('should get logs with pagination', async () => {
    const logs = [{ id: '1' }];
    mockRepo.createQueryBuilder().getManyAndCount.mockResolvedValue([logs, 1]);

    const result = await service.getLogs(1, 20, {});

    expect(result).toEqual({ data: logs, total: 1 });
  });
});
