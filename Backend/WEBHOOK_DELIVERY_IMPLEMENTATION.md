# Webhook Delivery Implementation Summary

## Problem Solved

**Issue**: `deliveryAttempts` increments on the event record while retry decisions are made per consumer. One failing consumer can affect retry accounting for other consumers.

**Solution**: Track delivery status and attempts per (eventId, consumerId) pair with independent retry state, status, last error, and delivery timestamps.

## Implementation Overview

### 1. Database Schema Changes

**New Models Added**:
- `WebhookConsumer`: Defines webhook endpoints with subscription preferences
- `WebhookEventDelivery`: Tracks delivery attempts per (eventId, consumerId)

**Key Features**:
- Unique constraint on (eventId, consumerId) ensures one delivery record per event per consumer
- Independent retry counters, error messages, and timestamps per consumer
- Efficient indexing for performance and monitoring queries

### 2. Core Services

#### WebhookDeliveryService
- Handles HTTP delivery attempts with timeout and retry logic
- Implements exponential backoff for failed deliveries
- HMAC signature verification for security
- Per-consumer statistics and health tracking

#### EventStorageService
- Integrates event storage with webhook delivery creation
- Creates delivery records for all matching consumers when events are stored
- Provides event delivery status tracking across consumers
- Enables event reprocessing for specific consumers

#### WebhookRetryTask
- Scheduled background processing of failed deliveries
- Health monitoring and stuck delivery recovery
- Automatic cleanup of old delivery records
- Daily summary reporting

### 3. Integration Points

#### Event Processor Integration
Modified `Backend/src/indexer/processors/event-processor.service.ts` to:
- Call `EventStorageService.storeEvent()` after successful event processing
- Automatically create webhook delivery records for matching consumers
- Maintain backward compatibility with existing event storage

#### Module Structure
```
Backend/src/webhook/
├── webhook.module.ts              # Module configuration
├── webhook.controller.ts          # REST API endpoints
├── webhook-delivery.service.ts    # Core delivery logic
├── event-storage.service.ts       # Event storage integration
├── webhook-retry.task.ts          # Background processing
├── README.md                      # Documentation
└── webhook.controller.spec.ts     # Unit tests
```

### 4. API Endpoints

**Consumer Management**:
- `POST /webhooks/consumers` - Create webhook consumer
- `GET /webhooks/consumers` - List consumers with statistics
- `GET /webhooks/consumers/:id` - Get consumer details
- `PUT /webhooks/consumers/:id` - Update consumer configuration
- `DELETE /webhooks/consumers/:id` - Delete consumer

**Delivery Management**:
- `GET /webhooks/consumers/:id/deliveries` - Get delivery history
- `POST /webhooks/consumers/:id/retry` - Retry failed deliveries
- `POST /webhooks/consumers/:id/test` - Test consumer endpoint
- `GET /webhooks/events/:eventId/deliveries` - Event delivery status
- `POST /webhooks/events/:eventId/reprocess` - Reprocess event

**Monitoring**:
- `GET /webhooks/stats` - Global delivery statistics
- `GET /webhooks/failures` - Events with delivery failures

### 5. Key Benefits

#### Independent Consumer Retry State
```sql
-- Before: Single delivery attempt counter per event
SELECT event_id, delivery_attempts FROM events;

-- After: Per-consumer delivery tracking
SELECT event_id, consumer_id, attempts, status, last_error 
FROM webhook_event_deliveries;
```

#### Flexible Event Filtering
```json
{
  "name": "AMM Events Consumer",
  "url": "https://api.example.com/webhooks",
  "eventTypes": ["swap", "liquidity_added", "liquidity_removed"],
  "contractIds": ["CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQAHHAGK"],
  "maxRetries": 5,
  "retryDelayMs": 10000
}
```

#### Comprehensive Monitoring
- Per-consumer success rates and health tracking
- Response time and error rate monitoring
- Automatic stuck delivery recovery
- Detailed delivery history and statistics

### 6. Performance Optimizations

#### Database Indexing
```sql
-- Efficient querying for pending deliveries
CREATE INDEX webhook_event_deliveries_status_attempts_idx 
ON webhook_event_deliveries(status, attempts);

-- Fast consumer filtering
CREATE INDEX webhook_consumers_active_idx 
ON webhook_consumers(active);
CREATE INDEX webhook_consumers_event_types_idx 
ON webhook_consumers(event_types);
```

#### Batched Processing
- Process deliveries in configurable batches (default: 100)
- Exponential backoff to avoid overwhelming failing consumers
- Automatic cleanup of old delivery records

#### Connection Management
- Configurable HTTP timeouts per consumer
- Efficient database connection pooling
- Rate limiting integration

### 7. Security Features

#### HMAC Signature Verification
```javascript
// Webhook payload signing
const signature = `sha256=${crypto
  .createHmac('sha256', consumer.secret)
  .update(JSON.stringify(payload))
  .digest('hex')}`;

// Consumer can verify with X-Stellara-Signature header
```

#### Webhook Headers
```
Content-Type: application/json
User-Agent: Stellara-Webhook-Delivery/1.0
X-Stellara-Event-Id: evt_123456
X-Stellara-Event-Type: transfer
X-Stellara-Delivery-Attempt: 2
X-Stellara-Signature: sha256=abc123...
```

### 8. Monitoring and Observability

#### Scheduled Health Checks
- **Every Minute**: Process pending deliveries
- **Every 5 Minutes**: Health report generation
- **Every Hour**: Reset stuck deliveries
- **Daily**: Cleanup and summary reports

#### Comprehensive Logging
```typescript
// Success logging
this.logger.log(
  `Successfully delivered event ${eventId} to ${consumerName} (${responseTime}ms)`
);

// Failure logging with context
this.logger.warn(
  `Delivery attempt ${attempts}/${maxRetries} failed for event ${eventId} 
   to consumer ${consumerName}: ${errorMessage}`
);
```

#### Statistics Endpoints
- Consumer-level success rates and delivery counts
- Global delivery statistics across all consumers
- Failed event identification and reprocessing

### 9. Migration Path

For systems migrating from event-level delivery tracking:

1. **Deploy** new webhook system alongside existing infrastructure
2. **Create** consumer records for existing webhook endpoints
3. **Update** event processing to use new delivery system
4. **Migrate** existing retry logic to per-consumer delivery records
5. **Remove** deprecated `deliveryAttempts` field from event records

### 10. Acceptance Criteria ✅

- [x] **Independent Retry State**: Each consumer has separate retry counters and error tracking
- [x] **Per-Consumer Status**: Delivery status tracked independently per (eventId, consumerId)
- [x] **Error Isolation**: One consumer failure doesn't affect others
- [x] **Delivery Timestamps**: Last attempt and successful delivery timestamps per consumer
- [x] **Flexible Filtering**: Consumers can subscribe to specific event types and contracts
- [x] **Monitoring**: Health tracking, success rates, and comprehensive statistics
- [x] **Performance**: Efficient indexing and batched processing
- [x] **Security**: HMAC signature verification and proper authentication

## Files Created/Modified

### New Files
- `Backend/src/webhook/webhook.module.ts`
- `Backend/src/webhook/webhook.controller.ts`
- `Backend/src/webhook/webhook-delivery.service.ts`
- `Backend/src/webhook/event-storage.service.ts`
- `Backend/src/webhook/webhook-retry.task.ts`
- `Backend/src/webhook/webhook.controller.spec.ts`
- `Backend/src/webhook/README.md`
- `Backend/prisma/migrations/001_add_webhook_consumer_models.sql`

### Modified Files
- `Backend/prisma/schema.prisma` - Added webhook models
- `Backend/src/app.module.ts` - Added WebhookModule
- `Backend/src/indexer/indexer.module.ts` - Added webhook services
- `Backend/src/indexer/processors/event-processor.service.ts` - Integrated webhook delivery

## Testing

Comprehensive unit tests included covering:
- Consumer CRUD operations
- Delivery retry logic
- Event processing integration
- Error handling scenarios
- API endpoint validation

Run tests with: `npm run test src/webhook`

## Next Steps

1. **Database Migration**: Apply the Prisma migration to add webhook tables
2. **Consumer Setup**: Create initial webhook consumers via API
3. **Monitoring**: Set up dashboards for delivery success rates
4. **Documentation**: Update API documentation with webhook endpoints
5. **Performance Tuning**: Monitor and optimize based on production load