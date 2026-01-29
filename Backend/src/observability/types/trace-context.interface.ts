/**
 * Trace context interface for propagating trace IDs across requests
 * Implements W3C Trace Context standard with custom extensions
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
  userId?: string;
  serviceName: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

/**
 * Distributed trace headers following W3C Trace Context
 */
export interface TraceHeaders {
  'traceparent': string; // W3C Trace Context format: version-traceId-parentId-traceFlags
  'tracestate'?: string; // W3C Trace State
  'x-trace-id': string; // Custom trace ID header
  'x-span-id': string; // Custom span ID header
  'x-request-id': string; // Request ID for correlation
}

/**
 * Span metadata for distributed tracing
 */
export interface SpanMetadata {
  operationName: string;
  spanKind: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
  attributes?: Record<string, any>;
  tags?: Record<string, string>;
}

/**
 * Log context for structured logging
 */
export interface LogContext {
  traceId: string;
  spanId: string;
  userId?: string;
  requestId?: string;
  correlationId?: string;
  [key: string]: any;
}

/**
 * Metric metadata
 */
export interface MetricMetadata {
  metricName: string;
  metricType: 'counter' | 'histogram' | 'gauge' | 'summary';
  labels?: Record<string, string>;
  value: number;
  timestamp?: number;
}
