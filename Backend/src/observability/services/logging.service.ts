import { Injectable } from '@nestjs/common';
import * as winston from 'winston';
import { LogContext } from '../types/trace-context.interface';

/**
 * Structured logging service using Winston
 * Integrates with distributed tracing for contextual logging
 */
@Injectable()
export class LoggingService {
  private logger: winston.Logger;
  private requestContextStorage = new Map<string, LogContext>();

  constructor() {
    this.initializeLogger();
  }

  /**
   * Initialize Winston logger with structured format
   */
  private initializeLogger() {
    const customFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
      winston.format.printf(({ level, message, timestamp, traceId, spanId, ...meta }) => {
        const context = {
          level,
          timestamp,
          message,
          ...(traceId && { traceId }),
          ...(spanId && { spanId }),
          ...meta,
        };
        return JSON.stringify(context);
      }),
    );

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: customFormat,
      defaultMeta: {
        service: process.env.SERVICE_NAME || 'stellara-backend',
      },
      transports: [
        // Console transport for development
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
          ),
        }),
        // File transport for all logs
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          maxsize: 10485760, // 10MB
          maxFiles: 5,
        }),
        new winston.transports.File({
          filename: 'logs/combined.log',
          maxsize: 10485760, // 10MB
          maxFiles: 10,
        }),
      ],
    });
  }

  /**
   * Set request context for correlation across logs
   */
  setRequestContext(traceId: string, context: LogContext) {
    this.requestContextStorage.set(traceId, context);
  }

  /**
   * Get request context by trace ID
   */
  getRequestContext(traceId: string): LogContext | undefined {
    return this.requestContextStorage.get(traceId);
  }

  /**
   * Clear request context
   */
  clearRequestContext(traceId: string) {
    this.requestContextStorage.delete(traceId);
  }

  /**
   * Log info level message with context
   */
  info(message: string, context?: LogContext | Record<string, any>) {
    this.logger.info(message, context);
  }

  /**
   * Log error level message with context
   */
  error(message: string, error?: Error | any, context?: LogContext | Record<string, any>) {
    const meta = context || {};
    if (error instanceof Error) {
      meta['error'] = {
        message: error.message,
        stack: error.stack,
        name: error.name,
      };
    } else if (error) {
      meta['error'] = error;
    }
    this.logger.error(message, meta);
  }

  /**
   * Log warn level message with context
   */
  warn(message: string, context?: LogContext | Record<string, any>) {
    this.logger.warn(message, context);
  }

  /**
   * Log debug level message with context
   */
  debug(message: string, context?: LogContext | Record<string, any>) {
    this.logger.debug(message, context);
  }

  /**
   * Log with custom level
   */
  log(level: string, message: string, context?: LogContext | Record<string, any>) {
    this.logger.log(level, message, context);
  }

  /**
   * Get underlying Winston logger instance
   */
  getLogger(): winston.Logger {
    return this.logger;
  }
}
