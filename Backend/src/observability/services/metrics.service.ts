import { Injectable } from '@nestjs/common';
import * as promClient from 'prom-client';

/**
 * Prometheus metrics service
 * Tracks key application metrics for monitoring and alerting
 */
@Injectable()
export class MetricsService {
  // HTTP Metrics
  private httpRequestDuration: promClient.Histogram;
  private httpRequestTotal: promClient.Counter;
  private httpRequestErrors: promClient.Counter;
  private httpRequestSize: promClient.Histogram;
  private httpResponseSize: promClient.Histogram;

  // WebSocket Metrics
  private websocketConnectionsActive: promClient.Gauge;
  private websocketConnectionsTotal: promClient.Counter;
  private websocketDisconnectionsTotal: promClient.Counter;
  private websocketMessagesTotal: promClient.Counter;

  // Queue/Job Metrics
  private jobDuration: promClient.Histogram;
  private jobsTotal: promClient.Counter;
  private jobsActive: promClient.Gauge;
  private jobsCompleted: promClient.Counter;
  private jobsFailed: promClient.Counter;
  private jobQueueSize: promClient.Gauge;

  // Database Metrics
  private databaseQueryDuration: promClient.Histogram;
  private databaseQueryErrors: promClient.Counter;
  private databaseConnectionPoolActive: promClient.Gauge;
  private databaseConnectionPoolSize: promClient.Gauge;

  // Business Metrics
  private activeUsers: promClient.Gauge;
  private transactionsTotal: promClient.Counter;
  private transactionErrors: promClient.Counter;

  // System Metrics
  private processUptime: promClient.Gauge;
  private processMemoryUsage: promClient.Gauge;

  constructor() {
    this.initializeMetrics();
    this.setupDefaultMetrics();
  }

  /**
   * Initialize all custom metrics
   */
  private initializeMetrics() {
    // HTTP Metrics
    this.httpRequestDuration = new promClient.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    });

    this.httpRequestTotal = new promClient.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
    });

    this.httpRequestErrors = new promClient.Counter({
      name: 'http_request_errors_total',
      help: 'Total HTTP request errors',
      labelNames: ['method', 'route', 'error_type'],
    });

    this.httpRequestSize = new promClient.Histogram({
      name: 'http_request_size_bytes',
      help: 'HTTP request size in bytes',
      labelNames: ['method', 'route'],
      buckets: [100, 1000, 10000, 100000, 1000000],
    });

    this.httpResponseSize = new promClient.Histogram({
      name: 'http_response_size_bytes',
      help: 'HTTP response size in bytes',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [100, 1000, 10000, 100000, 1000000],
    });

    // WebSocket Metrics
    this.websocketConnectionsActive = new promClient.Gauge({
      name: 'websocket_connections_active',
      help: 'Active WebSocket connections',
      labelNames: ['namespace'],
    });

    this.websocketConnectionsTotal = new promClient.Counter({
      name: 'websocket_connections_total',
      help: 'Total WebSocket connections',
      labelNames: ['namespace'],
    });

    this.websocketDisconnectionsTotal = new promClient.Counter({
      name: 'websocket_disconnections_total',
      help: 'Total WebSocket disconnections',
      labelNames: ['namespace', 'reason'],
    });

    this.websocketMessagesTotal = new promClient.Counter({
      name: 'websocket_messages_total',
      help: 'Total WebSocket messages',
      labelNames: ['namespace', 'event_type'],
    });

    // Queue/Job Metrics
    this.jobDuration = new promClient.Histogram({
      name: 'job_duration_seconds',
      help: 'Job execution duration in seconds',
      labelNames: ['job_name', 'status'],
      buckets: [1, 5, 10, 30, 60, 300],
    });

    this.jobsTotal = new promClient.Counter({
      name: 'jobs_total',
      help: 'Total jobs processed',
      labelNames: ['job_name', 'status'],
    });

    this.jobsActive = new promClient.Gauge({
      name: 'jobs_active',
      help: 'Currently active jobs',
      labelNames: ['job_name'],
    });

    this.jobsCompleted = new promClient.Counter({
      name: 'jobs_completed_total',
      help: 'Total completed jobs',
      labelNames: ['job_name'],
    });

    this.jobsFailed = new promClient.Counter({
      name: 'jobs_failed_total',
      help: 'Total failed jobs',
      labelNames: ['job_name', 'error_type'],
    });

    this.jobQueueSize = new promClient.Gauge({
      name: 'job_queue_size',
      help: 'Number of jobs in queue',
      labelNames: ['queue_name'],
    });

    // Database Metrics
    this.databaseQueryDuration = new promClient.Histogram({
      name: 'database_query_duration_seconds',
      help: 'Database query duration in seconds',
      labelNames: ['operation', 'table'],
      buckets: [0.001, 0.01, 0.1, 0.5, 1],
    });

    this.databaseQueryErrors = new promClient.Counter({
      name: 'database_query_errors_total',
      help: 'Total database query errors',
      labelNames: ['operation', 'table', 'error_type'],
    });

    this.databaseConnectionPoolActive = new promClient.Gauge({
      name: 'database_connection_pool_active',
      help: 'Active database connections',
    });

    this.databaseConnectionPoolSize = new promClient.Gauge({
      name: 'database_connection_pool_size',
      help: 'Database connection pool size',
    });

    // Business Metrics
    this.activeUsers = new promClient.Gauge({
      name: 'active_users_total',
      help: 'Number of active users',
    });

    this.transactionsTotal = new promClient.Counter({
      name: 'transactions_total',
      help: 'Total transactions',
      labelNames: ['type', 'status'],
    });

    this.transactionErrors = new promClient.Counter({
      name: 'transaction_errors_total',
      help: 'Total transaction errors',
      labelNames: ['type', 'error_reason'],
    });

    // System Metrics
    this.processUptime = new promClient.Gauge({
      name: 'process_uptime_seconds',
      help: 'Process uptime in seconds',
    });

    this.processMemoryUsage = new promClient.Gauge({
      name: 'process_memory_usage_bytes',
      help: 'Process memory usage in bytes',
      labelNames: ['type'],
    });
  }

  /**
   * Setup default Prometheus metrics
   */
  private setupDefaultMetrics() {
    // Collect default metrics (CPU, memory, GC, etc.)
    promClient.collectDefaultMetrics();

    // Update process metrics periodically
    setInterval(() => {
      const memUsage = process.memoryUsage();
      this.processUptime.set(process.uptime());
      this.processMemoryUsage.set({ type: 'heapUsed' }, memUsage.heapUsed);
      this.processMemoryUsage.set({ type: 'heapTotal' }, memUsage.heapTotal);
      this.processMemoryUsage.set({ type: 'rss' }, memUsage.rss);
    }, 5000); // Update every 5 seconds
  }

  // HTTP Metrics Methods

  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    duration: number,
    requestSize?: number,
    responseSize?: number,
  ) {
    this.httpRequestDuration.observe({ method, route, status_code: statusCode }, duration);
    this.httpRequestTotal.inc({ method, route, status_code: statusCode });
    if (requestSize) {
      this.httpRequestSize.observe({ method, route }, requestSize);
    }
    if (responseSize) {
      this.httpResponseSize.observe(
        { method, route, status_code: statusCode },
        responseSize,
      );
    }
  }

  recordHttpError(method: string, route: string, errorType: string) {
    this.httpRequestErrors.inc({ method, route, error_type: errorType });
  }

  // WebSocket Metrics Methods

  recordWebSocketConnection(namespace: string) {
    this.websocketConnectionsTotal.inc({ namespace });
    this.websocketConnectionsActive.inc({ namespace });
  }

  recordWebSocketDisconnection(namespace: string, reason: string) {
    this.websocketDisconnectionsTotal.inc({ namespace, reason });
    this.websocketConnectionsActive.dec({ namespace });
  }

  recordWebSocketMessage(namespace: string, eventType: string) {
    this.websocketMessagesTotal.inc({ namespace, event_type: eventType });
  }

  getActiveWebSocketConnections(namespace: string): number {
    // Note: prom-client doesn't expose direct values, would need custom implementation
    return 0;
  }

  // Queue/Job Metrics Methods

  recordJobStart(jobName: string) {
    this.jobsActive.inc({ job_name: jobName });
  }

  recordJobCompleted(jobName: string, duration: number) {
    this.jobDuration.observe({ job_name: jobName, status: 'success' }, duration);
    this.jobsTotal.inc({ job_name: jobName, status: 'success' });
    this.jobsCompleted.inc({ job_name: jobName });
    this.jobsActive.dec({ job_name: jobName });
  }

  recordJobFailed(jobName: string, duration: number, errorType: string) {
    this.jobDuration.observe({ job_name: jobName, status: 'failed' }, duration);
    this.jobsTotal.inc({ job_name: jobName, status: 'failed' });
    this.jobsFailed.inc({ job_name: jobName, error_type: errorType });
    this.jobsActive.dec({ job_name: jobName });
  }

  updateJobQueueSize(queueName: string, size: number) {
    this.jobQueueSize.set({ queue_name: queueName }, size);
  }

  // Database Metrics Methods

  recordDatabaseQuery(
    operation: string,
    table: string,
    duration: number,
  ) {
    this.databaseQueryDuration.observe({ operation, table }, duration);
  }

  recordDatabaseError(operation: string, table: string, errorType: string) {
    this.databaseQueryErrors.inc({ operation, table, error_type: errorType });
  }

  updateConnectionPoolStats(active: number, total: number) {
    this.databaseConnectionPoolActive.set(active);
    this.databaseConnectionPoolSize.set(total);
  }

  // Business Metrics Methods

  updateActiveUsers(count: number) {
    this.activeUsers.set(count);
  }

  recordTransaction(type: string, status: string) {
    this.transactionsTotal.inc({ type, status });
  }

  recordTransactionError(type: string, errorReason: string) {
    this.transactionErrors.inc({ type, error_reason: errorReason });
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return promClient.register.metrics();
  }

  /**
   * Get content type for metrics endpoint
   */
  getMetricsContentType(): string {
    return promClient.register.contentType;
  }
}
