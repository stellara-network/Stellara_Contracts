// src/voice/voice.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { VoiceService } from './voice.service';
import { VoiceJob, JobStatus, JobType } from './entities/voice-job.entity';

describe('VoiceService', () => {
  let service: VoiceService;
  let mockRepository;
  let mockQueue;

  beforeEach(async () => {
    mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    };

    mockQueue = {
      add: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        { provide: getRepositoryToken(VoiceJob), useValue: mockRepository },
        { provide: getQueueToken('voice-processing'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
  });

  describe('processSTT', () => {
    it('should create a new STT job and queue it', async () => {
      const mockFile = {
        originalname: 'test.mp3',
        buffer: Buffer.from('test'),
      } as Express.Multer.File;

      const mockJob = { id: 'job-123', type: JobType.STT };
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockReturnValue(mockJob);
      mockRepository.save.mockResolvedValue(mockJob);

      const jobId = await service.processSTT(mockFile);

      expect(jobId).toBe('job-123');
      expect(mockQueue.add).toHaveBeenCalledWith('process-stt', { jobId: 'job-123' });
    });

    it('should return existing job if duplicate detected', async () => {
      const mockFile = {
        originalname: 'test.mp3',
        buffer: Buffer.from('test'),
      } as Express.Multer.File;

      const existingJob = { id: 'existing-123', status: JobStatus.COMPLETED };
      mockRepository.findOne.mockResolvedValue(existingJob);

      const jobId = await service.processSTT(mockFile);

      expect(jobId).toBe('existing-123');
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getJobStatus', () => {
    it('should return job status', async () => {
      const mockJob = {
        id: 'job-123',
        type: JobType.STT,
        status: JobStatus.COMPLETED,
        text: 'Test transcription',
      };

      mockRepository.findOne.mockResolvedValue(mockJob);

      const status = await service.getJobStatus('job-123');

      expect(status.id).toBe('job-123');
      expect(status.status).toBe(JobStatus.COMPLETED);
      expect(status.text).toBe('Test transcription');
    });
  });
});