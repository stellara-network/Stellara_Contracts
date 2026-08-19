import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Canonical error codes used across the entire API.
 * Frontend and third-party consumers should branch on these codes,
 * not on HTTP status codes alone.
 */
export enum ApiErrorCode {
  // --- Generic ---
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',

  // --- Auth / Access ---
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  INVALID_NONCE = 'INVALID_NONCE',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_FAMILY_ABUSE = 'TOKEN_FAMILY_ABUSE',
  INSUFFICIENT_ROLE = 'INSUFFICIENT_ROLE',

  // --- Rate-limiting ---
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // --- Domain – Workflow ---
  WORKFLOW_NOT_FOUND = 'WORKFLOW_NOT_FOUND',
  WORKFLOW_INVALID_STATE = 'WORKFLOW_INVALID_STATE',
  STEP_NOT_FOUND = 'STEP_NOT_FOUND',
  STEP_INVALID_STATE = 'STEP_INVALID_STATE',
  RECOVERY_FAILED = 'RECOVERY_FAILED',
  COMPENSATION_FAILED = 'COMPENSATION_FAILED',

  // --- Domain – Wallet ---
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  WALLET_ALREADY_BOUND = 'WALLET_ALREADY_BOUND',
  WALLET_LAST_BOUND = 'WALLET_LAST_BOUND',
}

/**
 * Structure serialised into every error response body.
 */
export interface ApiErrorBody {
  success: false;
  statusCode: number;
  errorCode: ApiErrorCode | string;
  message: string;
  /** Optional machine-readable details (e.g. validation field errors). */
  details?: unknown;
  /** Correlation ID for tracing failed requests across services. */
  correlationId?: string;
  timestamp: string;
  path?: string;
}

/**
 * Base exception class for all domain-level API errors.
 *
 * Usage:
 *   throw new ApiError(HttpStatus.NOT_FOUND, ApiErrorCode.WORKFLOW_NOT_FOUND, 'Workflow not found');
 */
export class ApiError extends HttpException {
  public readonly errorCode: ApiErrorCode | string;
  public readonly details?: unknown;
  public readonly correlationId?: string;

  constructor(
    statusCode: HttpStatus,
    errorCode: ApiErrorCode | string,
    message: string,
    details?: unknown,
    correlationId?: string,
  ) {
    super({ errorCode, message, details, correlationId }, statusCode);
    this.errorCode = errorCode;
    this.details = details;
    this.correlationId = correlationId;
  }
}

// ─── Convenience sub-classes ────────────────────────────────────────────────

export class NotFoundError extends ApiError {
  constructor(
    message = 'Resource not found',
    errorCode = ApiErrorCode.NOT_FOUND,
  ) {
    super(HttpStatus.NOT_FOUND, errorCode, message);
  }
}

export class ConflictError extends ApiError {
  constructor(
    message = 'Resource already exists',
    errorCode = ApiErrorCode.CONFLICT,
  ) {
    super(HttpStatus.CONFLICT, errorCode, message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized', errorCode = ApiErrorCode.UNAUTHORIZED) {
    super(HttpStatus.UNAUTHORIZED, errorCode, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', errorCode = ApiErrorCode.FORBIDDEN) {
    super(HttpStatus.FORBIDDEN, errorCode, message);
  }
}

export class ValidationError extends ApiError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(
      HttpStatus.BAD_REQUEST,
      ApiErrorCode.VALIDATION_ERROR,
      message,
      details,
    );
  }
}

export class InvalidSignatureError extends ApiError {
  constructor(message = 'Invalid wallet signature') {
    super(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_SIGNATURE, message);
  }
}

export class InvalidNonceError extends ApiError {
  constructor(message = 'Invalid or expired nonce') {
    super(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_NONCE, message);
  }
}

export class TokenInvalidError extends ApiError {
  constructor(message = 'Invalid or expired token') {
    super(HttpStatus.UNAUTHORIZED, ApiErrorCode.TOKEN_INVALID, message);
  }
}

export class TokenExpiredError extends ApiError {
  constructor(message = 'Token expired') {
    super(HttpStatus.UNAUTHORIZED, ApiErrorCode.TOKEN_EXPIRED, message);
  }
}

export class WorkflowNotFoundError extends NotFoundError {
  constructor(id?: string) {
    super(
      id ? `Workflow '${id}' not found` : 'Workflow not found',
      ApiErrorCode.WORKFLOW_NOT_FOUND,
    );
  }
}

export class WorkflowInvalidStateError extends ApiError {
  constructor(message: string) {
    super(HttpStatus.BAD_REQUEST, ApiErrorCode.WORKFLOW_INVALID_STATE, message);
  }
}

export class StepNotFoundError extends NotFoundError {
  constructor(id?: string) {
    super(
      id ? `Step '${id}' not found` : 'Step not found',
      ApiErrorCode.STEP_NOT_FOUND,
    );
  }
}

export class StepInvalidStateError extends ApiError {
  constructor(message: string) {
    super(HttpStatus.BAD_REQUEST, ApiErrorCode.STEP_INVALID_STATE, message);
  }
}

export class InsufficientRoleError extends ForbiddenError {
  constructor(required: string | string[], actual?: string) {
    const needs = Array.isArray(required) ? required.join(' or ') : required;
    const msg = actual
      ? `Required role: ${needs}. User has: ${actual}`
      : `Required role: ${needs}`;
    super(msg, ApiErrorCode.INSUFFICIENT_ROLE);
  }
}

export class RateLimitError extends ApiError {
  constructor(retryAfter?: Date) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RATE_LIMIT_EXCEEDED,
      'Too many requests. Please slow down.',
      retryAfter ? { retryAfter: retryAfter.toISOString() } : undefined,
    );
  }
}
