import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID as uuidv4 } from 'crypto';
import {
  ApiError,
  ApiErrorBody,
  ApiErrorCode,
} from '../exceptions/api-error.exception';

/**
 * Global exception filter that converts any thrown exception into the
 * standard API error envelope:
 *
 * ```json
 * {
 *   "success": false,
 *   "statusCode": 404,
 *   "errorCode": "WORKFLOW_NOT_FOUND",
 *   "message": "Workflow '123' not found",
 *   "details": null,
 *   "timestamp": "2026-07-18T01:50:00.000Z",
 *   "path": "/admin/workflows/123"
 * }
 * ```
 *
 * Priority:
 * 1. `ApiError` subclass  → use its errorCode / details directly.
 * 2. `HttpException`      → map status → nearest ApiErrorCode.
 * 3. Unknown              → 500 INTERNAL_SERVER_ERROR (details hidden in prod).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const body = this.buildErrorBody(exception, request.url);

    // Log 5xx as errors, 4xx as warnings
    if (body.statusCode >= 500) {
      this.logger.error(
        `[${body.statusCode}] ${body.errorCode}: ${body.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${body.statusCode}] ${body.errorCode}: ${body.message}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private buildErrorBody(exception: unknown, path: string): ApiErrorBody {
    const timestamp = new Date().toISOString();
    const correlationId = uuidv4();

    // ── 1. Our own typed ApiError ────────────────────────────────────────────
    if (exception instanceof ApiError) {
      return {
        success: false,
        statusCode: exception.getStatus(),
        errorCode: exception.errorCode,
        message: exception.message,
        details: exception.details ?? null,
        correlationId: exception.correlationId ?? correlationId,
        timestamp,
        path,
      };
    }

    // ── 2. Generic NestJS HttpException (includes class-validator pipe) ──────
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      // ValidationPipe returns { message: string[], statusCode, error }
      let message: string;
      let details: unknown = null;

      if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = Array.isArray(resObj.message)
          ? (resObj.message as string[]).join('; ')
          : typeof resObj.message === 'string'
            ? resObj.message
            : String(exception.message);
        if (Array.isArray(resObj.message) && resObj.message.length > 1) {
          details = resObj.message;
        }
      } else {
        message = String(res);
      }

      return {
        success: false,
        statusCode: status,
        errorCode: this.httpStatusToErrorCode(status),
        message,
        details,
        timestamp,
        path,
      };
    }

    // ── 3. Unexpected / unhandled error ──────────────────────────────────────
    const isProduction = process.env.NODE_ENV === 'production';
    return {
      success: false,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ApiErrorCode.INTERNAL_SERVER_ERROR,
      message: isProduction
        ? 'An unexpected error occurred. Please try again later.'
        : exception instanceof Error
          ? exception.message
          : String(exception),
      details: null,
      timestamp,
      path,
    };
  }

  private httpStatusToErrorCode(status: number): ApiErrorCode {
    const map: Record<number, ApiErrorCode> = {
      400: ApiErrorCode.VALIDATION_ERROR,
      401: ApiErrorCode.UNAUTHORIZED,
      403: ApiErrorCode.FORBIDDEN,
      404: ApiErrorCode.NOT_FOUND,
      409: ApiErrorCode.CONFLICT,
      429: ApiErrorCode.RATE_LIMIT_EXCEEDED,
      500: ApiErrorCode.INTERNAL_SERVER_ERROR,
    };
    return map[status] ?? ApiErrorCode.INTERNAL_SERVER_ERROR;
  }
}
