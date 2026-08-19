import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog, AuditLogArchive } from './audit.entity';

describe('AuditService', () => {
  let service: AuditService;
  let repo: Repository<AuditLog>;
  let logs: AuditLog[];
  let archives: AuditLogArchive[];

  const sortByChainOrder = <T extends { timestamp: Date; id: string }>(
    entries: T[],
    direction: 'ASC' | 'DESC' = 'ASC',
  ) =>
    [...entries].sort((a, b) => {
      const timestampDiff =
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      const result =
        timestampDiff === 0 ? a.id.localeCompare(b.id) : timestampDiff;
      return direction === 'ASC' ? result : -result;
    });

  const createQueryBuilder = () => ({
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([logs, logs.length]),
    getMany: jest.fn().mockResolvedValue([]),
  });

  const createMockRepo = <T extends { id: string; timestamp: Date }>(
    store: T[],
  ) => ({
    create: jest.fn((value) => value),
    save: jest.fn((value) => {
      if (Array.isArray(value)) {
        store.push(...value);
        return value;
      }

      const saved = {
        ...value,
        id: value.id ?? `audit-${store.length + 1}`,
      };
      store.push(saved);
      return saved;
    }),
    clear: jest.fn(() => {
      store.splice(0, store.length);
    }),
    delete: jest.fn(() => undefined),
    findOne: jest.fn(() => sortByChainOrder(store, 'DESC')[0] ?? null),
    find: jest.fn(() => sortByChainOrder(store, 'ASC')),
    createQueryBuilder: jest.fn(createQueryBuilder),
  });

  beforeEach(async () => {
    logs = [];
    archives = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: createMockRepo(logs),
        },
        {
          provide: getRepositoryToken(AuditLogArchive),
          useValue: createMockRepo(archives),
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback: string) =>
              key === 'AUDIT_LOG_HMAC_KEY' ? 'unit-test-key' : fallback,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
    repo = module.get<Repository<AuditLog>>(getRepositoryToken(AuditLog));
  });

  it('should log an action', async () => {
    const result = await service.logAction('USER_CREATED', 'user1', 'entity1', {
      key: 'value',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'USER_CREATED',
        actor_id: 'user1',
        entity_id: 'entity1',
        metadata: { key: 'value' },
        timestamp: expect.any(Date),
        previousHash: '',
      }),
    );
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'USER_CREATED',
        actor_id: 'user1',
        previousHash: '',
        hash: expect.any(String),
        signature: expect.any(String),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'audit-1',
        action_type: 'USER_CREATED',
      }),
    );
  });

  it('should get logs with pagination', async () => {
    logs.push({ id: '1', timestamp: new Date() } as AuditLog);

    const result = await service.getLogs(1, 20, {});

    expect(result).toEqual({ data: logs, total: 1 });
  });

  it('should fail verification when a log entry is modified', async () => {
    await service.logAction('USER_CREATED', 'user1', 'entity1', {
      key: 'value',
    });
    await service.logAction('USER_UPDATED', 'user1', 'entity1', {
      key: 'updated',
    });

    await expect(service.verifyAuditChain()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 2,
      failures: [],
    });

    logs[0].metadata = { key: 'tampered' };

    await expect(service.verifyAuditChain()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 2,
      failures: [
        expect.objectContaining({
          id: 'audit-1',
          reason: 'signature does not match entry contents',
        }),
      ],
    });

    logs[0].metadata = { key: 'value' };
    logs[0].actor_id = 'attacker';

    await expect(service.verifyAuditChain()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 2,
      failures: expect.arrayContaining([
        expect.objectContaining({
          id: 'audit-1',
          reason: 'hash does not match entry contents',
        }),
      ]),
    });
  });
});
