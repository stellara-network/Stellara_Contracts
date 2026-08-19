/**
 * The distinct processing stages a voice job can pass through.
 *
 * The stage is persisted alongside the coarse `status` so that the pipeline
 * is observable and resumable: a retry can inspect the persisted stage and the
 * already-persisted outputs (`transcribedText`, `generatedAudioUrl`) to decide
 * which work is safe to skip.
 */
export enum VoiceJobStage {
  /** Audio bytes are being received / written to durable storage. */
  UPLOADING = 'uploading',
  /** Audio has been persisted and its content hash recorded. */
  UPLOADED = 'uploaded',
  /** The job has been handed to the queue and is waiting for a worker. */
  QUEUED = 'queued',
  /** A worker is calling the transcription (STT) provider. */
  TRANSCRIBING = 'transcribing',
  /** Transcription succeeded and the transcript is persisted. */
  TRANSCRIPTION_COMPLETED = 'transcription_completed',
  /** A worker is calling the text-to-speech (TTS) provider. */
  GENERATING_TTS = 'generating_tts',
  /** The job finished successfully and the final artifact is persisted. */
  COMPLETED = 'completed',
  /** The job permanently failed (non-retryable, or retries exhausted). */
  FAILED = 'failed',
}
