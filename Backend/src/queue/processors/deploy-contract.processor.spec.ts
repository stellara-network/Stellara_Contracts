import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { DeployContractProcessor } from './deploy-contract.processor';
import { QueueIdempotencyGuard } from '../queue-idempotency.guard';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';

describe('DeployContractProcessor', () => {
  let processor: DeployContractProcessor;

  const mockJob = {
    id: '123',
    data: {
      contractName: 'TestContract',
      contractCode: 'contract code here',
      network: 'testnet',
      initializer: 'init-func',
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    progress: jest.fn(),
    log: jest.fn(),
    queue: { name: 'deploy-contract' },
  };

  beforeEach(async () => {
    mockJob.progress = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeployContractProcessor,
        { provide: getQueueToken('failed-jobs'), useValue: { add: jest.fn() } },
        {
          provide: QueueIdempotencyGuard,
          useValue: {
            isDuplicate: jest.fn().mockResolvedValue({ isDuplicate: false }),
            generateIdempotencyKey: jest.fn().mockReturnValue('mock-key'),
          },
        },
        {
          provide: QueueJobTracingWrapper,
          useValue: {
            wrapProcessor: jest.fn().mockImplementation((fn: any) => fn),
          },
        },
      ],
    }).compile();

    processor = module.get<DeployContractProcessor>(DeployContractProcessor);
  });

  describe('handleDeployContract', () => {
    it('should successfully deploy contract', async () => {
      mockJob.data = {
        contractName: 'TestContract',
        contractCode: 'contract code here',
        network: 'testnet',
        initializer: 'init-func',
      };
      const result = await processor.handleDeployContract(mockJob as any);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('contractAddress');
      expect(result.data).toHaveProperty('transactionHash');
      expect(result.data).toHaveProperty('deployedAt');
    });

    it('should update progress', async () => {
      mockJob.data = {
        contractName: 'TestContract',
        contractCode: 'contract code here',
        network: 'testnet',
        initializer: 'init-func',
      };
      await processor.handleDeployContract(mockJob as any);

      expect(mockJob.progress).toHaveBeenCalledWith(10);
      expect(mockJob.progress).toHaveBeenCalledWith(30);
      expect(mockJob.progress).toHaveBeenCalledWith(50);
      expect(mockJob.progress).toHaveBeenCalledWith(90);
      expect(mockJob.progress).toHaveBeenCalledWith(100);
    });

    it('should throw error if required fields missing', async () => {
      mockJob.data = {
        contractName: '',
        contractCode: 'code',
        network: 'testnet',
        initializer: 'init',
      };

      await expect(
        processor.handleDeployContract(mockJob as any),
      ).rejects.toThrow('Missing required fields');
    });

    it('should throw error if contract code is empty', async () => {
      mockJob.data = {
        contractName: 'TestContract',
        contractCode: '',
        network: 'testnet',
        initializer: 'init-func',
      };

      await expect(
        processor.handleDeployContract(mockJob as any),
      ).rejects.toThrow();
    });

    it('should include network in result', async () => {
      mockJob.data = {
        contractName: 'TestContract',
        contractCode: 'contract code here',
        network: 'testnet',
        initializer: 'init-func',
      };
      const result = await processor.handleDeployContract(mockJob as any);

      expect(result.data.network).toBe('testnet');
    });

    it('should include contract name in result', async () => {
      mockJob.data = {
        contractName: 'TestContract',
        contractCode: 'contract code here',
        network: 'testnet',
        initializer: 'init-func',
      };
      const result = await processor.handleDeployContract(mockJob as any);

      expect(result.data.contractName).toBe('TestContract');
    });
  });
});
