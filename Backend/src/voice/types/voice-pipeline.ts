import { VoiceJobStage } from './voice-job-stage.enum';
import { JobType } from '../entities/voice-job.entity';

/**
 * Deterministic progress percentage associated with each stage.
 *
 * Progress is deliberately coarse: it only ever changes when a stage boundary
 * is crossed, so we do not generate a storm of database writes while a
 * provider call is in flight. A failed job keeps whatever progress it had
 * reached — it is never reported as 100 and never exceeds 100.
 */
export const STAGE_PROGRESS: Record<VoiceJobStage, number> = {
  [VoiceJobStage.UPLOADING]: 10,
  [VoiceJobStage.UPLOADED]: 20,
  [VoiceJobStage.QUEUED]: 30,
  [VoiceJobStage.TRANSCRIBING]: 55,
  [VoiceJobStage.TRANSCRIPTION_COMPLETED]: 70,
  [VoiceJobStage.GENERATING_TTS]: 85,
  [VoiceJobStage.COMPLETED]: 100,
  [VoiceJobStage.FAILED]: 0, // never applied directly; see note below.
};

/**
 * The stage(s) that complete each job type. `null`-able outputs act as
 * checkpoints: if the corresponding output is already persisted, the work is
 * considered done and is never repeated.
 */
export function stagesFor(type: JobType): VoiceJobStage[] {
  switch (type) {
    case JobType.STT:
      return [
        VoiceJobStage.UPLOADING,
        VoiceJobStage.UPLOADED,
        VoiceJobStage.QUEUED,
        VoiceJobStage.TRANSCRIBING,
        VoiceJobStage.TRANSCRIPTION_COMPLETED,
        VoiceJobStage.COMPLETED,
      ];
    case JobType.TTS:
      return [
        VoiceJobStage.QUEUED,
        VoiceJobStage.GENERATING_TTS,
        VoiceJobStage.COMPLETED,
      ];
    default:
      return [VoiceJobStage.QUEUED, VoiceJobStage.COMPLETED];
  }
}

/**
 * Progress to report when a stage begins. Clamped to [0, 100].
 */
export function progressForStage(stage: VoiceJobStage): number {
  const value = STAGE_PROGRESS[stage] ?? 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * `FAILED` must never set progress to 100; callers should retain the last
 * meaningful progress. This helper returns the safe progress to persist when a
 * job fails: it never exceeds 99 and never goes backwards.
 */
export function clampProgress(value: number): number {
  return Math.max(0, Math.min(99, Math.round(value)));
}
