import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

/**
 * Shape of every successful API response.
 *
 * ```json
 * {
 *   "success": true,
 *   "statusCode": 200,
 *   "data": { ... },
 *   "timestamp": "2026-07-18T01:50:00.000Z",
 *   "path": "/auth/me"
 * }
 * ```
 */
export interface ResponseEnvelope<T = unknown> {
  success: true;
  statusCode: number;
  data: T;
  timestamp: string;
  path: string;
}

/**
 * Intercepts every successful controller response and wraps it in
 * the standard `ResponseEnvelope` shape.
 *
 * Error responses are handled separately by `HttpExceptionFilter`
 * (which runs *after* this interceptor in the pipeline).
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<
  T,
  ResponseEnvelope<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ResponseEnvelope<T>> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<{ statusCode: number }>();

    return next.handle().pipe(
      map((data) => ({
        success: true,
        statusCode: response.statusCode,
        data,
        timestamp: new Date().toISOString(),
        path: request.url,
      })),
    );
  }
}
