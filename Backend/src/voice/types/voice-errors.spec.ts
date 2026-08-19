import {
  VoiceErrorCode,
  VoiceProcessingError,
  transientProviderFailure,
  permanentProviderFailure,
  validationFailure,
  normalizeVoiceError,
  redact,
} from './voice-errors';
import { VoiceJobStage } from './voice-job-stage.enum';
import {
  TransientError,
  PermanentError,
  ValidationError,
} from '../../queue/types/errors';

describe('voice-errors', () => {
  describe('redact (TEST 9)', () => {
    it('strips authorization headers and tokens from messages', () => {
      const dirty =
        'Request failed: Authorization: Bearer sk-1234567890, X-Api-Key: abc, access_token=secret';
      const clean = redact(dirty);

      expect(clean).not.toContain('sk-1234567890');
      expect(clean).not.toContain('abc');
      expect(clean).not.toContain('secret');
      expect(clean).toContain('[REDACTED]');
    });

    it('truncates very long messages', () => {
      expect(redact('a'.repeat(5000)).length).toBeLessThanOrEqual(512);
    });
  });

  describe('normalizeVoiceError', () => {
    it('passes through an already-normalized error', () => {
      const err = transientProviderFailure(
        VoiceErrorCode.PROVIDER_TIMEOUT,
        'timed out',
        'whisper',
        VoiceJobStage.TRANSCRIBING,
      );
      const normalized = normalizeVoiceError(err, {
        code: VoiceErrorCode.TRANSCRIPTION_FAILED,
        stage: VoiceJobStage.TRANSCRIBING,
      });
      expect(normalized).toBe(err);
      expect(normalized.retryable).toBe(true);
    });

    it('maps TransientError to a retryable provider failure', () => {
      const normalized = normalizeVoiceError(
        new TransientError('network timeout'),
        {
          code: VoiceErrorCode.TRANSCRIPTION_FAILED,
          stage: VoiceJobStage.TRANSCRIBING,
          provider: 'whisper',
        },
      );
      expect(normalized.retryable).toBe(true);
      expect(normalized.category).toBe('provider_transient');
    });

    it('maps PermanentError/ValidationError to non-retryable failures', () => {
      const permanent = normalizeVoiceError(
        new PermanentError('bad response'),
        {
          code: VoiceErrorCode.TRANSCRIPTION_FAILED,
          stage: VoiceJobStage.TRANSCRIBING,
        },
      );
      expect(permanent.retryable).toBe(false);

      const validation = normalizeVoiceError(new ValidationError('bad input'), {
        code: VoiceErrorCode.TRANSCRIPTION_FAILED,
        stage: VoiceJobStage.TRANSCRIBING,
      });
      expect(validation.retryable).toBe(false);
    });

    it('classifies HTTP 429 and 5xx as retryable', () => {
      const rateLimited = normalizeVoiceError(
        { response: { status: 429 }, message: 'too many requests' },
        {
          code: VoiceErrorCode.TTS_FAILED,
          stage: VoiceJobStage.GENERATING_TTS,
          provider: 'x',
        },
      );
      expect(rateLimited.retryable).toBe(true);
      expect(rateLimited.code).toBe(VoiceErrorCode.PROVIDER_RATE_LIMITED);

      const serverError = normalizeVoiceError(
        { response: { status: 503 }, message: 'unavailable' },
        {
          code: VoiceErrorCode.TTS_FAILED,
          stage: VoiceJobStage.GENERATING_TTS,
          provider: 'x',
        },
      );
      expect(serverError.retryable).toBe(true);
    });

    it('classifies 4xx (except 429) as permanent', () => {
      const auth = normalizeVoiceError(
        { response: { status: 401 }, message: 'unauthorized' },
        {
          code: VoiceErrorCode.TTS_FAILED,
          stage: VoiceJobStage.GENERATING_TTS,
          provider: 'x',
        },
      );
      expect(auth.retryable).toBe(false);
      expect(auth.code).toBe(VoiceErrorCode.PROVIDER_AUTH);
    });

    it('classifies unknown errors as non-retryable internal errors', () => {
      const unknown = normalizeVoiceError(new Error('something broke'), {
        code: VoiceErrorCode.TRANSCRIPTION_FAILED,
        stage: VoiceJobStage.TRANSCRIBING,
      });
      expect(unknown.retryable).toBe(false);
      expect(unknown.code).toBe(VoiceErrorCode.INTERNAL_ERROR);
    });
  });

  describe('VoiceProcessingError.toMetadata', () => {
    it('produces safe, structured metadata without internal stacks', () => {
      const err = permanentProviderFailure(
        VoiceErrorCode.PROVIDER_AUTH,
        'Authorization: Bearer secret',
        'whisper',
        VoiceJobStage.TRANSCRIBING,
      );
      const meta = err.toMetadata(2, 'corr-1');

      expect(meta.code).toBe(VoiceErrorCode.PROVIDER_AUTH);
      expect(meta.provider).toBe('whisper');
      expect(meta.attempt).toBe(2);
      expect(meta.correlationId).toBe('corr-1');
      expect(meta.retryable).toBe(false);
      expect(meta.message).not.toContain('secret');
      expect(meta).not.toHaveProperty('stack');
    });
  });

  it('exposes convenience constructors with correct retryability', () => {
    expect(transientProviderFailure('' as any, '', '').retryable).toBe(true);
    expect(permanentProviderFailure('' as any, '', '').retryable).toBe(false);
    expect(validationFailure('' as any, '').retryable).toBe(false);
    expect(
      new VoiceProcessingError('' as any, '', 'internal', false).retryable,
    ).toBe(false);
  });
});
