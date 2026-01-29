import { Injectable } from '@nestjs/common';
import { Socket } from 'socket.io';
import { TracingService } from '../services/tracing.service';
import { LoggingService } from '../services/logging.service';
import { MetricsService } from '../services/metrics.service';
import { TraceContext } from '../types/trace-context.interface';

/**
 * WebSocket Tracing Adapter
 * Manages trace context for WebSocket connections and messages
 * Records metrics for WebSocket events
 */
@Injectable()
export class WebSocketTracingAdapter {
  private socketTraceMap = new Map<string, TraceContext>();

  constructor(
    private tracingService: TracingService,
    private loggingService: LoggingService,
    private metricsService: MetricsService,
  ) {}

  /**
   * Initialize tracing for WebSocket connection
   */
  initializeConnection(socket: Socket, namespace: string): TraceContext {
    // Extract trace context from handshake query/headers
    const handshakeHeaders = socket.handshake.headers;
    const traceContext = this.tracingService.extractTraceContext(
      handshakeHeaders as Record<string, string>,
    );

    // Store trace context for this socket
    this.socketTraceMap.set(socket.id, traceContext);

    // Attach trace context to socket
    (socket as any).traceContext = traceContext;

    // Record metrics
    this.metricsService.recordWebSocketConnection(namespace);

    // Log connection
    this.loggingService.info('WebSocket connection established', {
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      socketId: socket.id,
      namespace,
      userId: traceContext.userId,
      remoteAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent'],
    });

    return traceContext;
  }

  /**
   * Handle WebSocket disconnection
   */
  handleDisconnection(socketId: string, namespace: string, reason: string) {
    const traceContext = this.socketTraceMap.get(socketId);

    if (traceContext) {
      // Record metrics
      this.metricsService.recordWebSocketDisconnection(namespace, reason);

      // Log disconnection
      this.loggingService.info('WebSocket connection closed', {
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        socketId,
        namespace,
        reason,
        userId: traceContext.userId,
      });

      // Clean up
      this.socketTraceMap.delete(socketId);
    }
  }

  /**
   * Record WebSocket message with tracing
   */
  recordMessage(
    socketId: string,
    namespace: string,
    eventType: string,
    messageSize: number = 0,
  ) {
    const traceContext = this.socketTraceMap.get(socketId);

    if (traceContext) {
      // Record metrics
      this.metricsService.recordWebSocketMessage(namespace, eventType);

      // Log message
      this.loggingService.debug('WebSocket message', {
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        socketId,
        namespace,
        eventType,
        messageSize,
        userId: traceContext.userId,
      });
    }
  }

  /**
   * Inject trace context into WebSocket message
   */
  injectTraceContext(socketId: string): Record<string, string> {
    const traceContext = this.socketTraceMap.get(socketId);
    if (!traceContext) {
      return {};
    }
    return this.tracingService.injectTraceContext(traceContext);
  }

  /**
   * Get trace context for socket
   */
  getTraceContext(socketId: string): TraceContext | undefined {
    return this.socketTraceMap.get(socketId);
  }

  /**
   * Update trace context metadata
   */
  updateMetadata(socketId: string, metadata: Record<string, any>) {
    const traceContext = this.socketTraceMap.get(socketId);
    if (traceContext) {
      this.tracingService.addMetadata(traceContext.traceId, metadata);
    }
  }

  /**
   * Get all active WebSocket connections with trace info
   */
  getActiveConnections(): Map<string, TraceContext> {
    return new Map(this.socketTraceMap);
  }

  /**
   * Get active connection count
   */
  getActiveConnectionCount(): number {
    return this.socketTraceMap.size;
  }
}
