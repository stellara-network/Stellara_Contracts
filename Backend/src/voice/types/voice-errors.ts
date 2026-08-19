import { VoiceJobStage } from './voice-job-stage.enum';
import { QueueJobError, TransientError } from '../../queue/types/errors';

/**
 * High-level classification of a voice failure. Used both for internal
 * decisions (should we retry?) and for the API-facing failure payload.
 */
export type VoiceErrorCategory =
  | 'validation'
  | 'provider_transient'
  | 'provider_permanent'
  | 'internal';

/**
 * Stable, provider-agnostic error codes. These are what API consumers and
 * dashboards key off; they never contain provider credentials or stack traces.
 */
export enum VoiceErrorCode {
  INVALID_AUDIO = 'INVALID_AUDIO',
  UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',
  INVALID_TEXT = 'INVALID_TEXT',
  TRANSCRIPTION_FAILED = 'TRANSCRIPTION_FAILED',
  TTS_FAILED = 'TTS_FAILED',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  PROVIDER_RATE_LIMITED = 'PROVIDER_RATE_LIMITED',
  PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT',
  PROVIDER_AUTH = 'PROVIDER_AUTH',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Structured failure metadata persisted on the job and exposed through the
 * API. Deliberately excludes secrets, tokens, and internal stack traces.
 */
export interface VoiceFailureMetadata {
  code: string;
  category: VoiceErrorCategory;
  message: string;
  retryable: boolean;
  stage: string;
  provider?: string;
  attempt: number;
  timestamp: string;
  correlationId?: string;
}

/**
 * A normalized voice-processing failure. Different providers raise different
 * errors; this is the single internal shape they are all reduced to.
 */
export class VoiceProcessingError extends Error {
  constructor(
    public readonly code: VoiceErrorCode,
    message: string,
    public readonly category: VoiceErrorCategory,
    public readonly retryable: boolean,
    public readonly provider?: string,
    public readonly stage?: VoiceJobStage | string,
    public readonly cause?: unknown,
  ) {
    super(redact(message));
    this.name = 'VoiceProcessingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toMetadata(attempt: number, correlationId?: string): VoiceFailureMetadata {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      stage: String(this.stage ?? ''),
      provider: this.provider,
      attempt,
      timestamp: new Date().toISOString(),
      correlationId,
    };
  }
}

/** Convenience constructors that keep call sites terse and consistent. */
export function validationFailure(
  code: VoiceErrorCode,
  message: string,
  stage?: VoiceJobStage | string,
): VoiceProcessingError {
  return new VoiceProcessingError(
    code,
    message,
    'validation',
    false,
    undefined,
    stage,
  );
}

export function transientProviderFailure(
  code: VoiceErrorCode,
  message: string,
  provider: string,
  stage?: VoiceJobStage | string,
  cause?: unknown,
): VoiceProcessingError {
  return new VoiceProcessingError(
    code,
    message,
    'provider_transient',
    true,
    provider,
    stage,
    cause,
  );
}

export function permanentProviderFailure(
  code: VoiceErrorCode,
  message: string,
  provider: string,
  stage?: VoiceJobStage | string,
  cause?: unknown,
): VoiceProcessingError {
  return new VoiceProcessingError(
    code,
    message,
    'provider_permanent',
    false,
    provider,
    stage,
    cause,
  );
}

export function internalFailure(
  message: string,
  stage?: VoiceJobStage | string,
  cause?: unknown,
): VoiceProcessingError {
  return new VoiceProcessingError(
    VoiceErrorCode.INTERNAL_ERROR,
    message,
    'internal',
    false,
    undefined,
    stage,
    cause,
  );
}

const SENSITIVE_KEY = [
  'authorization',
  'x-api-key',
  'api[_-]?key',
  'access[_-]?token',
  'client[_-]?secret',
  'private[_-]?key',
  'password',
  'secret',
].join('|');

const BEARER_TOKEN = /bearer\s+[A-Za-z0-9._\-~+/=]+/gi;
const KEY_VALUE = new RegExp(`(${SENSITIVE_KEY})\\s*[:=]\\s*[^\\s,;]+`, 'gi');
const BARE_KEY = new RegExp(`(${SENSITIVE_KEY})`, 'gi');

/**
 * Strip anything that looks like a credential out of an error message before it
 * is persisted or logged. Best-effort; providers should already avoid echoing
 * credentials, this is defence in depth.
 */
export function redact(message: string): string {
  let out = String(message ?? '');
  out = out.replace(BEARER_TOKEN, '[REDACTED]');
  out = out.replace(KEY_VALUE, '[REDACTED]');
  out = out.replace(BARE_KEY, '[REDACTED]');
  return out.slice(0, 512);
}

/** Minimal shape of the errors axios (and similar HTTP clients) throw. */
interface ProviderHttpError {
  response?: { status?: number };
  status?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

function isProviderHttpError(error: unknown): error is ProviderHttpError {
  return typeof error === 'object' && error !== null;
}

/**
 * Reduce an arbitrary thrown value into a `VoiceProcessingError`.
 *
 * - Already-normalized errors pass through.
 * - The shared queue error taxonomy (`TransientError`, `PermanentError`,
 *   `ValidationError`) is mapped onto the voice categories.
 * - Axios-style errors are classified by status code / code (429, 5xx, network
 *   timeouts are transient; 4xx is permanent).
 * - Anything else is treated as a non-retryable internal error so we never
 *   retry into an infinite loop on an unclassifiable failure.
 */
export function normalizeVoiceError(
  error: unknown,
  fallback: {
    code: VoiceErrorCode;
    stage: VoiceJobStage | string;
    provider?: string;
    retryable?: boolean;
  },
): VoiceProcessingError {
  if (error instanceof VoiceProcessingError) {
    return error;
  }

  if (error instanceof TransientError) {
    return transientProviderFailure(
      fallback.code,
      redact(error.message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      error,
    );
  }

  if (error instanceof QueueJobError) {
    return permanentProviderFailure(
      fallback.code,
      redact(error.message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      error,
    );
  }

  const err: ProviderHttpError = isProviderHttpError(error) ? error : {};
  const status = err.response?.status ?? err.status ?? err.statusCode;
  const axiosCode = err.code;
  const message = err.message ?? 'Unknown error';

  if (status === 429) {
    return transientProviderFailure(
      VoiceErrorCode.PROVIDER_RATE_LIMITED,
      redact(message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      err,
    );
  }

  if (status === 401 || status === 403) {
    return permanentProviderFailure(
      VoiceErrorCode.PROVIDER_AUTH,
      redact(message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      err,
    );
  }

  if (typeof status === 'number' && status >= 500) {
    return transientProviderFailure(
      VoiceErrorCode.PROVIDER_UNAVAILABLE,
      redact(message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      err,
    );
  }

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return permanentProviderFailure(
      fallback.code,
      redact(message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      err,
    );
  }

  if (
    axiosCode === 'ECONNABORTED' ||
    axiosCode === 'ETIMEDOUT' ||
    axiosCode === 'ECONNRESET' ||
    axiosCode === 'ENOTFOUND'
  ) {
    return transientProviderFailure(
      VoiceErrorCode.PROVIDER_TIMEOUT,
      redact(message),
      fallback.provider ?? 'unknown',
      fallback.stage,
      err,
    );
  }

  return internalFailure(redact(message), fallback.stage, err);
}
