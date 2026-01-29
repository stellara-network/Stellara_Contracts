import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { v4 as uuidv4, v4 } from 'uuid';
import { TraceContext, TraceHeaders } from '../types/trace-context.interface';

/**
 * Distributed tracing service using Jaeger/OpenTelemetry concepts
 * Manages trace context propagation across HTTP, WebSocket, and job workers
 */
@Injectable()
export class TracingService implements OnModuleDestroy {
  private traceContextMap = new Map<string, TraceContext>();
  private readonly SERVICE_NAME = process.env.SERVICE_NAME || 'stellara-backend';
  private jaegerEnabled = process.env.JAEGER_ENABLED === 'true';
  private jaegerAgentHost = process.env.JAEGER_AGENT_HOST || 'localhost';
  private jaegerAgentPort = parseInt(process.env.JAEGER_AGENT_PORT || '6831');
  private jaegerUdpSender: any = null;

  constructor() {
    if (this.jaegerEnabled) {
      this.initializeJaeger();
    }
  }

  /**
   * Initialize Jaeger tracing (optional - can be extended for full Jaeger integration)
   */
  private initializeJaeger() {
    try {
      // This is a placeholder for Jaeger initialization
      // In production, you'd use @opentelemetry packages for full integration
      console.log(
        `[Tracing] Jaeger initialized: ${this.jaegerAgentHost}:${this.jaegerAgentPort}`,
      );
    } catch (error) {
      console.error('[Tracing] Failed to initialize Jaeger:', error);
    }
  }

  /**
   * Create a new trace context for incoming request
   */
  createTraceContext(
    traceId?: string,
    parentSpanId?: string,
    userId?: string,
    metadata?: Record<string, any>,
  ): TraceContext {
    const finalTraceId = traceId || this.generateTraceId();
    const spanId = this.generateSpanId();

    const context: TraceContext = {
      traceId: finalTraceId,
      spanId,
      parentSpanId,
      sampled: this.shouldSample(),
      userId,
      serviceName: this.SERVICE_NAME,
      timestamp: Date.now(),
      metadata,
    };

    this.traceContextMap.set(finalTraceId, context);
    return context;
  }

  /**
   * Extract trace context from incoming headers
   */
  extractTraceContext(headers: Record<string, string>): TraceContext {
    // Try to extract from W3C traceparent header
    const traceparent = headers['traceparent'] || headers['Traceparent'];
    let traceId: string | undefined;
    let parentSpanId: string | undefined;

    if (traceparent) {
      const parts = traceparent.split('-');
      if (parts.length >= 3) {
        traceId = parts[1];
        parentSpanId = parts[2];
      }
    }

    // Fallback to custom headers
    traceId = traceId || headers['x-trace-id'] || headers['X-Trace-Id'];
    parentSpanId =
      parentSpanId || headers['x-span-id'] || headers['X-Span-Id'];

    const userId = headers['x-user-id'] || headers['X-User-Id'];
    const correlationId =
      headers['x-correlation-id'] || headers['X-Correlation-Id'];

    return this.createTraceContext(
      traceId,
      parentSpanId,
      userId,
      correlationId ? { correlationId } : undefined,
    );
  }

  /**
   * Get or create child span
   */
  createChildSpan(parentTraceId: string): TraceContext {
    const parentContext = this.traceContextMap.get(parentTraceId);
    if (!parentContext) {
      throw new Error(`Parent trace context not found: ${parentTraceId}`);
    }

    const childSpan = this.createTraceContext(
      parentTraceId,
      parentContext.spanId,
      parentContext.userId,
      parentContext.metadata,
    );

    return childSpan;
  }

  /**
   * Get trace context
   */
  getTraceContext(traceId: string): TraceContext | undefined {
    return this.traceContextMap.get(traceId);
  }

  /**
   * Update trace context with additional metadata
   */
  addMetadata(traceId: string, metadata: Record<string, any>) {
    const context = this.traceContextMap.get(traceId);
    if (context) {
      context.metadata = { ...context.metadata, ...metadata };
    }
  }

  /**
   * Convert trace context to outgoing headers
   */
  injectTraceContext(context: TraceContext): TraceHeaders {
    const traceFlags = context.sampled ? '01' : '00';
    const traceparent = `00-${context.traceId}-${context.spanId}-${traceFlags}`;

    return {
      'traceparent': traceparent,
      'x-trace-id': context.traceId,
      'x-span-id': context.spanId,
      'x-request-id': context.traceId, // Use trace ID as request ID
      ...(context.userId && { 'x-user-id': context.userId }),
    };
  }

  /**
   * Clean up trace context
   */
  removeTraceContext(traceId: string) {
    this.traceContextMap.delete(traceId);
  }

  /**
   * Generate unique trace ID (128-bit hex string)
   */
  private generateTraceId(): string {
    // Generate 16-byte hex string (128 bits)
    return uuidv4().replace(/-/g, '').substring(0, 32);
  }

  /**
   * Generate unique span ID (64-bit hex string)
   */
  private generateSpanId(): string {
    // Generate 8-byte hex string (64 bits)
    return uuidv4().replace(/-/g, '').substring(0, 16);
  }

  /**
   * Sampling decision (configurable ratio)
   */
  private shouldSample(): boolean {
    const samplingRate = parseFloat(
      process.env.SAMPLING_RATE || '1.0',
    );
    return Math.random() < samplingRate;
  }

  /**
   * Get all active trace contexts
   */
  getActiveTraces(): Map<string, TraceContext> {
    return new Map(this.traceContextMap);
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    this.traceContextMap.clear();
  }
}
