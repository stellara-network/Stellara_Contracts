import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const CORRELATION_HEADER = 'x-request-id';

/**
 * Correlation Middleware
 * Ensures every inbound HTTP request carries a correlation ID.
 * - If the caller supplies `X-Request-ID`, it is reused.
 * - Otherwise a fresh UUID v4 is generated.
 * The ID is attached to the request object (`req.correlationId`) and echoed
 * back in the response header so downstream consumers can correlate.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    req.headers[CORRELATION_HEADER] = correlationId;
    (req as any).correlationId = correlationId;

    _res.setHeader(CORRELATION_HEADER, correlationId);

    next();
  }
}
