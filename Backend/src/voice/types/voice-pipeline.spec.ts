import { VoiceJobStage } from './voice-job-stage.enum';
import {
  STAGE_PROGRESS,
  stagesFor,
  progressForStage,
  clampProgress,
} from './voice-pipeline';
import { JobType } from '../entities/voice-job.entity';

describe('voice-pipeline', () => {
  it('orders STT stages from upload through completion', () => {
    expect(stagesFor(JobType.STT)).toEqual([
      VoiceJobStage.UPLOADING,
      VoiceJobStage.UPLOADED,
      VoiceJobStage.QUEUED,
      VoiceJobStage.TRANSCRIBING,
      VoiceJobStage.TRANSCRIPTION_COMPLETED,
      VoiceJobStage.COMPLETED,
    ]);
  });

  it('orders TTS stages from queued through completion', () => {
    expect(stagesFor(JobType.TTS)).toEqual([
      VoiceJobStage.QUEUED,
      VoiceJobStage.GENERATING_TTS,
      VoiceJobStage.COMPLETED,
    ]);
  });

  it('never maps a stage to progress above 100', () => {
    for (const stage of Object.values(VoiceJobStage)) {
      expect(progressForStage(stage)).toBeLessThanOrEqual(100);
    }
  });

  it('reports 100 only for the COMPLETED stage (TEST 8)', () => {
    expect(STAGE_PROGRESS[VoiceJobStage.COMPLETED]).toBe(100);
    for (const stage of Object.values(VoiceJobStage)) {
      if (stage !== VoiceJobStage.COMPLETED) {
        expect(STAGE_PROGRESS[stage]).toBeLessThan(100);
      }
    }
  });

  it('clamps failed-job progress below 100 (TEST 8)', () => {
    expect(clampProgress(100)).toBe(99);
    expect(clampProgress(150)).toBe(99);
    expect(clampProgress(55)).toBe(55);
    expect(clampProgress(-5)).toBe(0);
  });
});
