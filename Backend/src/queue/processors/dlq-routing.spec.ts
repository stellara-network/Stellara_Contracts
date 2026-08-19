import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { DeployContractProcessor } from './deploy-contract.processor';
import { ProcessTtsProcessor } from './process-tts.processor';
import { IndexMarketNewsProcessor } from './index-market-news.processor';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';
import {
  ValidationError,
  TransientError,
  PermanentError,
} from '../types/errors';

const makeDlqQueue = () => ({ add: jest.fn() });

const makeJob = (data: any, attemptsMade = 3, maxAttempts = 3): any => ({
  id: 'job-1',
  data,
  attemptsMade,
  opts: { attempts: maxAttempts },
  progress: jest.fn(),
  queue: { name: 'test' },
});

// ─── DeployContractProcessor ─────────────────────────────────────────────────

describe('DeployContractProcessor — DLQ routing', () => {
  let processor: DeployContractProcessor;
  let dlqQueue: ReturnType<typeof makeDlqQueue>;

  beforeEach(async () => {
    dlqQueue = makeDlqQueue();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeployContractProcessor,
        { provide: getQueueToken('failed-jobs'), useValue: dlqQueue },
        {
          provide: QueueJobTracingWrapper,
          useValue: { wrapProcessor: (fn: any) => fn },
        },
      ],
    }).compile();
    processor = module.get(DeployContractProcessor);
  });

  it('routes to DLQ on ValidationError (non-retryable)', async () => {
    const job = makeJob({ contractName: '', contractCode: '', network: '' });
    const err = new ValidationError('missing fields');
    await processor.onFailed(job, err);
    expect(dlqQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({ originalQueue: 'deploy-contract' }),
    );
  });

  it('routes to DLQ on PermanentError', async () => {
    const job = makeJob({
      contractName: 'C',
      contractCode: 'x',
      network: 'testnet',
    });
    const err = new PermanentError('permanent failure');
    await processor.onFailed(job, err);
    expect(dlqQueue.add).toHaveBeenCalled();
  });

  it('routes to DLQ after retries exhausted with TransientError', async () => {
    const job = makeJob({}, 3, 3);
    const err = new TransientError('timeout');
    await processor.onFailed(job, err);
    expect(dlqQueue.add).toHaveBeenCalled();
  });

  it('does NOT route to DLQ when retries remain for TransientError', async () => {
    const job = makeJob({}, 1, 3); // 1 of 3 attempts used
    const err = new TransientError('timeout');
    await processor.onFailed(job, err);
    expect(dlqQueue.add).not.toHaveBeenCalled();
  });
});

// ─── ProcessTtsProcessor ─────────────────────────────────────────────────────

describe('ProcessTtsProcessor — DLQ routing', () => {
  let processor: ProcessTtsProcessor;
  let dlqQueue: ReturnType<typeof makeDlqQueue>;

  beforeEach(async () => {
    dlqQueue = makeDlqQueue();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessTtsProcessor,
        { provide: getQueueToken('failed-jobs'), useValue: dlqQueue },
        {
          provide: QueueJobTracingWrapper,
          useValue: { wrapProcessor: (fn: any) => fn },
        },
      ],
    }).compile();
    processor = module.get(ProcessTtsProcessor);
  });

  it('routes to DLQ on ValidationError (missing fields)', async () => {
    const job = makeJob({ text: '', voiceId: '' });
    await processor.onFailed(job, new ValidationError('missing'));
    expect(dlqQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({ originalQueue: 'process-tts' }),
    );
  });

  it('does NOT route to DLQ when retries remain', async () => {
    const job = makeJob({ text: 'hi', voiceId: 'v1' }, 1, 3);
    await processor.onFailed(job, new TransientError('network'));
    expect(dlqQueue.add).not.toHaveBeenCalled();
  });
});

// ─── IndexMarketNewsProcessor ─────────────────────────────────────────────────

describe('IndexMarketNewsProcessor — DLQ routing', () => {
  let processor: IndexMarketNewsProcessor;
  let dlqQueue: ReturnType<typeof makeDlqQueue>;

  beforeEach(async () => {
    dlqQueue = makeDlqQueue();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexMarketNewsProcessor,
        { provide: getQueueToken('failed-jobs'), useValue: dlqQueue },
        {
          provide: QueueJobTracingWrapper,
          useValue: { wrapProcessor: (fn: any) => fn },
        },
      ],
    }).compile();
    processor = module.get(IndexMarketNewsProcessor);
  });

  it('routes to DLQ on ValidationError (missing source)', async () => {
    const job = makeJob({ source: '' });
    await processor.onFailed(job, new ValidationError('missing source'));
    expect(dlqQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({ originalQueue: 'index-market-news' }),
    );
  });

  it('routes to DLQ on PermanentError', async () => {
    const job = makeJob({ source: 'coindesk' });
    await processor.onFailed(job, new PermanentError('index unavailable'));
    expect(dlqQueue.add).toHaveBeenCalled();
  });

  it('does NOT route to DLQ when retries remain', async () => {
    const job = makeJob({ source: 'coindesk' }, 2, 3);
    await processor.onFailed(job, new TransientError('rate limited'));
    expect(dlqQueue.add).not.toHaveBeenCalled();
  });
});
