import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VoiceJobStage } from '../types/voice-job-stage.enum';
import {
  VoiceErrorCode,
  normalizeVoiceError,
  validationFailure,
  transientProviderFailure,
  permanentProviderFailure,
} from '../types/voice-errors';

/**
 * Thin abstraction over the external transcription (STT) and text-to-speech
 * (TTS) providers.
 *
 * Every external failure is normalized into a `VoiceProcessingError` so that
 * the processor can make a consistent retry decision regardless of which
 * provider was in use. Provider implementations are currently mocked; swap the
 * bodies for real SDK/HTTP calls without changing the error contract.
 */
@Injectable()
export class VoiceProviderService {
  private readonly logger = new Logger(VoiceProviderService.name);

  constructor(private readonly config: ConfigService) {}

  private get sttProvider(): string {
    return this.config.get<string>('VOICE_STT_PROVIDER') ?? 'whisper';
  }

  private get ttsProvider(): string {
    return this.config.get<string>('VOICE_TTS_PROVIDER') ?? 'openai-tts';
  }

  /**
   * Transcribe persisted audio. Throws a normalized error on any failure.
   */
  async transcribe(audioUrl: string | null): Promise<string> {
    const provider = this.sttProvider;

    if (!audioUrl) {
      throw validationFailure(
        VoiceErrorCode.INVALID_AUDIO,
        'No audio file is associated with this job',
        VoiceJobStage.TRANSCRIBING,
      );
    }

    try {
      // TODO: replace with a real Whisper (or configured provider) call.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return 'Transcribed text from audio';
    } catch (err) {
      const normalized = normalizeVoiceError(err, {
        code: VoiceErrorCode.TRANSCRIPTION_FAILED,
        stage: VoiceJobStage.TRANSCRIBING,
        provider,
      });
      this.logProviderFailure('stt', provider, normalized);
      throw normalized;
    }
  }

  /**
   * Generate speech from text. The output path is deterministic for a given
   * `jobId`, so a retry writes to the same file rather than creating a
   * duplicate artifact.
   */
  async synthesize(text: string, jobId: string): Promise<string> {
    const provider = this.ttsProvider;

    if (!text || !text.trim()) {
      throw validationFailure(
        VoiceErrorCode.INVALID_TEXT,
        'No text was provided for speech synthesis',
        VoiceJobStage.GENERATING_TTS,
      );
    }

    if (text.length > 5000) {
      throw validationFailure(
        VoiceErrorCode.INVALID_TEXT,
        'Text exceeds maximum length of 5000 characters',
        VoiceJobStage.GENERATING_TTS,
      );
    }

    const outputDir = path.join(process.cwd(), 'uploads', 'tts');
    const fileName = `${jobId}-speech.mp3`;
    const filePath = path.join(outputDir, fileName);

    try {
      await fs.mkdir(outputDir, { recursive: true });
      // TODO: replace with a real TTS provider call (OpenAI TTS, Google TTS…).
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await fs.writeFile(filePath, Buffer.from(''));
      return filePath;
    } catch (err) {
      const normalized = normalizeVoiceError(err, {
        code: VoiceErrorCode.TTS_FAILED,
        stage: VoiceJobStage.GENERATING_TTS,
        provider,
      });
      this.logProviderFailure('tts', provider, normalized);
      throw normalized;
    }
  }

  /**
   * Log a normalized provider failure without leaking credentials.
   */
  private logProviderFailure(
    kind: 'stt' | 'tts',
    provider: string,
    error: ReturnType<typeof normalizeVoiceError>,
  ): void {
    this.logger.error(`${kind.toUpperCase()} provider failure (${provider})`, {
      code: error.code,
      category: error.category,
      retryable: error.retryable,
      message: error.message,
    });
  }

  // Exposed for completeness; makes transient/permanent construction visible
  // to future provider implementations.
  protected readonly transient = transientProviderFailure;
  protected readonly permanent = permanentProviderFailure;
}
