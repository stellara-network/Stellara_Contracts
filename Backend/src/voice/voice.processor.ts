// src/voice/voice.processor.ts
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VoiceJob, JobStatus } from './entities/voice-job.entity';
import { VoiceService } from './voice.service';
import * as fs from 'fs/promises';
import * as path from 'path';

@Processor('voice-processing')
export class VoiceProcessor {
  constructor(
    @InjectRepository(VoiceJob)
    private voiceJobRepository: Repository<VoiceJob>,
    private voiceService: VoiceService,
  ) {}

  @Process('process-stt')
  async handleSTT(job: Job) {
    const { jobId } = job.data;
    
    try {
      const voiceJob = await this.voiceJobRepository.findOne({ where: { id: jobId } });
      if (!voiceJob) throw new Error('Job not found');

      await this.voiceService.updateJobStatus(jobId, JobStatus.PROCESSING);

      // Simulate Whisper API call
      const transcribedText = await this.transcribeAudio(voiceJob.audioUrl);

      await this.voiceService.updateJobStatus(jobId, JobStatus.COMPLETED, {
        text: transcribedText,
      });
    } catch (error) {
      const canRetry = await this.voiceService.incrementRetry(jobId);
      
      if (canRetry) {
        await this.voiceService.updateJobStatus(jobId, JobStatus.PENDING);
        throw error; // Bull will retry
      } else {
        await this.voiceService.updateJobStatus(jobId, JobStatus.FAILED, {
          errorMessage: error.message,
        });
      }
    }
  }

  @Process('process-tts')
  async handleTTS(job: Job) {
    const { jobId } = job.data;
    
    try {
      const voiceJob = await this.voiceJobRepository.findOne({ where: { id: jobId } });
      if (!voiceJob) throw new Error('Job not found');

      await this.voiceService.updateJobStatus(jobId, JobStatus.PROCESSING);

      // Simulate TTS API call
      const audioPath = await this.generateSpeech(voiceJob.text);

      await this.voiceService.updateJobStatus(jobId, JobStatus.COMPLETED, {
        resultAudioUrl: audioPath,
      });
    } catch (error) {
      const canRetry = await this.voiceService.incrementRetry(jobId);
      
      if (canRetry) {
        await this.voiceService.updateJobStatus(jobId, JobStatus.PENDING);
        throw error; // Bull will retry
      } else {
        await this.voiceService.updateJobStatus(jobId, JobStatus.FAILED, {
          errorMessage: error.message,
        });
      }
    }
  }

  private async transcribeAudio(audioPath: string): Promise<string> {
    // TODO: Integrate with OpenAI Whisper API
    // Example implementation:
    // const formData = new FormData();
    // formData.append('file', fs.createReadStream(audioPath));
    // formData.append('model', 'whisper-1');
    // const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    //   method: 'POST',
    //   headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    //   body: formData
    // });
    
    // For now, return mock data
    await new Promise(resolve => setTimeout(resolve, 2000));
    return 'Transcribed text from audio';
  }

  private async generateSpeech(text: string): Promise<string> {
    // TODO: Integrate with TTS API (OpenAI TTS, Google Cloud TTS, etc.)
    // Example implementation:
    // const response = await fetch('https://api.openai.com/v1/audio/speech', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: text })
    // });
    
    const outputDir = path.join(process.cwd(), 'uploads', 'tts');
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `${Date.now()}-speech.mp3`;
    const filePath = path.join(outputDir, fileName);
    
    // Mock: create empty file
    await fs.writeFile(filePath, Buffer.from(''));
    
    return filePath;
  }
}
