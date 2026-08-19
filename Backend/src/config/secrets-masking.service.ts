import { Injectable, Logger } from '@nestjs/common';

/**
 * SecretsMaskingService
 *
 * Centralises all logic for masking sensitive values before they appear
 * in log output, exception messages, or any diagnostic payload sent
 * outside the process boundary.
 *
 * Usage:
 *   const safe = maskingService.mask(rawString);
 *   logger.error(`Connection failed: ${safe}`);
 */
@Injectable()
export class SecretsMaskingService {
  private readonly logger = new Logger(SecretsMaskingService.name);

  /**
   * Environment-variable names whose values must never appear in full.
   * Values are masked to `***<KEY>***` in any string that contains them.
   */
  private static readonly SECRET_ENV_KEYS: readonly string[] = [
    'JWT_SECRET',
    'DB_PASSWORD',
    'REDIS_PASSWORD',
    'REDIS_URL',
    'DATABASE_URL',
    'VAULT_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'LLM_API_KEY',
    'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'API_KEY',
    'SECRET',
    'PASSWORD',
    'TOKEN',
  ];

  /**
   * Regex patterns that match secret-looking substrings.
   * Each entry is [pattern, safeReplacement].
   */
  private static readonly SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
    // Bearer / JWT in Authorization headers
    [
      /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,
      'Bearer ***JWT***',
    ],
    // Passwords embedded in connection URLs:  redis://:password@host or postgres://user:password@host
    [
      /(redis|rediss|postgres|postgresql|mysql|mongodb|amqp):\/\/[^:@\s]*:[^@\s]+@/gi,
      '$1://***:***@',
    ],
    // Query-string style secrets: ?token=xxx, &password=xxx, &secret=xxx
    [/([?&](token|secret|password|key|apikey|api_key)=)[^\s&"']+/gi, '$1***'],
    // JSON key-value pairs for common secret keys
    [
      /("(?:password|secret|token|key|apiKey|api_key|Authorization)"\s*:\s*")[^"]*"/gi,
      '$1***"',
    ],
    // Hex/base64 values that follow "secret", "token", "key" (case-insensitive)
    [
      /\b(secret|token|password|key)\b\s*[:=]\s*['"]?[A-Za-z0-9+/=_\-]{8,}['"]?/gi,
      '$1=***',
    ],
  ];

  /**
   * Mask any known secrets from a string.
   *
   * @param input   The string that may contain secret material.
   * @returns       A copy of the string with secrets replaced by `***`.
   */
  mask(input: string): string {
    if (!input) return input;

    let output = input;

    // 1. Replace literal env-var values that are present in the process
    for (const key of SecretsMaskingService.SECRET_ENV_KEYS) {
      const value = process.env[key];
      if (value && value.length >= 4 && output.includes(value)) {
        output = output.split(value).join(`***${key}***`);
      }
    }

    // 2. Apply structural regex patterns
    for (const [
      pattern,
      replacement,
    ] of SecretsMaskingService.SECRET_PATTERNS) {
      output = output.replace(pattern, replacement);
    }

    return output;
  }

  /**
   * Mask an Error object's message (and optionally its stack trace)
   * in-place, returning the same error so callers can re-throw it.
   *
   * @param error   Any Error instance.
   * @returns       The same Error with its message and stack sanitised.
   */
  maskError(error: Error): Error {
    error.message = this.mask(error.message);
    if (error.stack) {
      error.stack = this.mask(error.stack);
    }
    return error;
  }

  /**
   * Deeply mask all string values inside a plain object.
   * Non-string, non-object values are returned as-is.
   * Arrays are traversed recursively.
   *
   * @param obj   An arbitrary object / array.
   * @returns     A new object with all string leaves masked.
   */
  maskObject(obj: unknown): unknown {
    if (typeof obj === 'string') return this.mask(obj);
    if (Array.isArray(obj)) return obj.map((item) => this.maskObject(item));
    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        result[k] = this.maskObject(v);
      }
      return result;
    }
    return obj;
  }

  /**
   * Convenience wrapper: masks a value and logs it at the ERROR level.
   */
  logMaskedError(context: string, message: string): void {
    this.logger.error(this.mask(message), context);
  }

  /**
   * Convenience wrapper: masks a value and logs it at the WARN level.
   */
  logMaskedWarn(context: string, message: string): void {
    this.logger.warn(this.mask(message), context);
  }
}
