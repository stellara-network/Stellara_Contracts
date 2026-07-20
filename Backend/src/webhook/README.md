# Webhook Delivery System

This module provides per-consumer webhook delivery tracking for Stellar blockchain events, solving the issue where delivery attempts were tracked at the event level rather than per consumer.

## Problem Solved

**Before**: `deliveryAttempts` was incremented on the event record while retry decisions were made per consumer. This meant one failing consumer could affect retry accounting for other consumers.

**After**: Each consumer has independent retry state, status, last error, and delivery timestamps tracked in the `WebhookEventDelivery` model.

## Architecture

### Models

- **WebhookConsumer**: Defines webhook endpoints that subscribe to events
- **WebhookEventDelivery**: Tracks delivery attempts per (eventId, consumerId) pair

### Services

- **WebhookDeliveryService**: Handles HTTP delivery and retry logic
- **EventStorageService**: Integrates event storage with webhook delivery creation
- **WebhookRetryTask**: Background scheduler for processing retries

### Key Features

1. **Per-Consumer Retry Tracking**: Each consumer has independent retry counters and error states
2. **Flexible Event Filtering**: Consumers can subscribe to specific event types and contract IDs
3. **Exponential Backoff**: Built-in retry delays with exponential backoff
4. **Health Monitoring**: Track consumer health and success rates
5. **Security**: HMAC signature verification for webhook payloads
6. **Performance**: Efficient indexing and batched processing

## API Endpoints

### Consumer Management

```bash
# Create webhook consumer
POST /webhooks/consumers
{
  "name": "My API Consumer",
  "url": "https://api.example.com/webhooks/stellar",
  "secret": "webhook-secret-key",
  "eventTypes": ["transfer", "swap"],
  "contractIds": ["CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQAHHAGK"],
  "maxRetries": 3,
  "timeout": 30000
}

# List consumers with stats
GET /webhooks/consumers

# Get consumer details
GET /webhooks/consumers/:id

# Update consumer
PUT /webhooks/consumers/:id

# Delete consumer
DELETE /webhooks/consumers/:id
```

### Delivery Management

```bash
# Get consumer delivery history
GET /webhooks/consumers/:id/deliveries?status=FAILED&limit=50

# Retry failed deliveries
POST /webhooks/consumers/:id/retry

# Test consumer endpoint
POST /webhooks/consumers/:id/test

# Get event delivery status across all consumers
GET /webhooks/events/:eventId/deliveries

# Reprocess event for specific consumers
POST /webhooks/events/:eventId/reprocess
{
  "consumerIds": ["consumer-1", "consumer-2"]
}
```

### Statistics

```bash
# Global delivery statistics
GET /webhooks/stats

# Events with delivery failures
GET /webhooks/failures?limit=50
```

## Webhook Payload Format

```json
{
  "eventId": "evt_1234567890",
  "eventType": "transfer",
  "contractId": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQAHHAGK",
  "transactionHash": "abc123def456...",
  "timestamp": "2024-07-20T12:00:00.000Z",
  "ledgerSeq": 12345678,
  "data": {
    "from": "GAXXX...",
    "to": "GBYYY...",
    "amount": "1000000000"
  }
}
```

## Webhook Headers

- `Content-Type: application/json`
- `User-Agent: Stellara-Webhook-Delivery/1.0`
- `X-Stellara-Event-Id: {eventId}`
- `X-Stellara-Event-Type: {eventType}`
- `X-Stellara-Delivery-Attempt: {attemptNumber}`
- `X-Stellara-Signature: sha256={hmac}` (if secret configured)

## Security

### HMAC Verification

Webhooks are signed with HMAC-SHA256 when a secret is configured:

```javascript
// Verify webhook signature
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;
  
  return signature === expectedSignature;
}
```

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/stellara

# Optional: Redis for rate limiting
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Webhook delivery settings (optional)
WEBHOOK_DEFAULT_TIMEOUT=30000
WEBHOOK_MAX_RETRIES=3
WEBHOOK_RETRY_DELAY=5000
```

### Consumer Configuration

```json
{
  "name": "Human-readable name",
  "url": "https://your-api.com/webhook/endpoint",
  "secret": "optional-webhook-secret",
  "eventTypes": ["*"] // or ["transfer", "swap", "liquidity_added"]
  "contractIds": ["*"] // or specific contract IDs
  "maxRetries": 3,
  "retryDelayMs": 5000,
  "timeout": 30000,
  "active": true
}
```

## Event Types

Supported event types include:

- `transfer` - Token transfers
- `approval` - Token approvals
- `swap` - AMM swaps
- `liquidity_added` - Liquidity pool additions
- `liquidity_removed` - Liquidity pool removals
- Custom contract events

## Monitoring

### Health Checks

The system provides several monitoring mechanisms:

1. **Consumer Health**: Tracked via `lastHealthy` timestamp
2. **Success Rates**: Calculated delivery success percentages
3. **Error Tracking**: Detailed error messages and response codes
4. **Performance Metrics**: Response times and attempt counts

### Scheduled Tasks

- **Every Minute**: Process pending/failed deliveries
- **Every 5 Minutes**: Generate health reports
- **Every Hour**: Reset stuck deliveries
- **Daily**: Cleanup old records and generate summaries

### Logs

```bash
# View webhook delivery logs
kubectl logs -f deployment/stellara-backend | grep WebhookDelivery

# View retry task logs
kubectl logs -f deployment/stellara-backend | grep WebhookRetry
```

## Database Schema

```sql
-- Webhook consumers
CREATE TABLE webhook_consumers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  active BOOLEAN DEFAULT true,
  max_retries INTEGER DEFAULT 3,
  retry_delay_ms INTEGER DEFAULT 5000,
  timeout INTEGER DEFAULT 30000,
  event_types TEXT[],
  contract_ids TEXT[],
  description TEXT,
  tags JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_healthy TIMESTAMP
);

-- Per-consumer delivery tracking
CREATE TABLE webhook_event_deliveries (
  id TEXT PRIMARY KEY,
  consumer_id TEXT REFERENCES webhook_consumers(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_data JSONB NOT NULL,
  status webhook_delivery_status DEFAULT 'PENDING',
  attempts INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMP,
  last_error TEXT,
  response_status INTEGER,
  response_time_ms INTEGER,
  response_body TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP,
  
  UNIQUE(event_id, consumer_id)
);
```

## Migration from Legacy System

If migrating from the old system where `deliveryAttempts` was tracked on events:

1. **Deploy** the new webhook system alongside the existing one
2. **Create** consumers for existing webhook endpoints
3. **Migrate** existing retry logic to use per-consumer delivery records
4. **Remove** the old `deliveryAttempts` field from event records

## Testing

```bash
# Unit tests
npm run test src/webhook

# Integration tests
npm run test:e2e webhook

# Test webhook consumer
curl -X POST http://localhost:3000/webhooks/consumers/test-consumer-id/test \
  -H "Content-Type: application/json" \
  -d '{"test": "payload"}'
```

## Troubleshooting

### Common Issues

1. **High Failure Rates**: Check consumer endpoint health and network connectivity
2. **Stuck Deliveries**: The system automatically resets stuck deliveries hourly
3. **Performance Issues**: Consider adding more indexes or scaling horizontally
4. **Signature Verification Failures**: Ensure webhook secrets match

### Debugging

```bash
# Check consumer stats
GET /webhooks/consumers/:id

# View failed deliveries
GET /webhooks/consumers/:id/deliveries?status=FAILED

# Check global statistics
GET /webhooks/stats

# View events with failures
GET /webhooks/failures
```

## Performance Considerations

- **Indexing**: Proper indexes on status, consumer_id, and timestamps
- **Batching**: Process deliveries in batches to avoid overwhelming consumers
- **Cleanup**: Automatic cleanup of old delivery records
- **Rate Limiting**: Built-in rate limiting to prevent abuse
- **Connection Pooling**: Efficient database connection management

## Future Enhancements

- Dead letter queue for permanently failed deliveries
- Webhook delivery analytics dashboard
- Custom retry policies per consumer
- Webhook delivery ordering guarantees
- Multi-region delivery redundancy