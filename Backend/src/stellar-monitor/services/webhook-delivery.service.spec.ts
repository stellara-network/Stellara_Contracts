import { createHmac } from 'crypto';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { ConsumerManagementService } from './consumer-management.service';
import { EventStorageService } from './event-storage.service';
import { WebhookConsumer } from '../entities/webhook-consumer.entity';
import { StellarEvent } from '../entities/stellar-event.entity';
import { DeliveryStatus, EventType } from '../types/stellar.types';
import { isPrivateIp, validateWebhookUrl } from '../utils/ssrf.util';
import { IsSafeWebhookUrlConstraint } from '../validators/is-safe-webhook-url.validator';

describe('SSRF protection (ssrf.util)', () => {
  describe('isPrivateIp', () => {
    it.each([
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata endpoint
      '172.16.0.1',
      '172.31.255.255',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
    ])('rejects private/internal address %s', (ip) => {
      expect(isPrivateIp(ip)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::'])(
      'accepts public address %s',
      (ip) => {
        expect(isPrivateIp(ip)).toBe(false);
      },
    );
  });

  describe('validateWebhookUrl', () => {
    it.each([
      'http://127.0.0.1/hook',
      'http://localhost:3000/hook',
      'http://10.0.0.5/hook',
      'http://192.168.1.10/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/hook',
    ])('rejects private URL %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow();
    });

    it('rejects non-http(s) schemes', async () => {
      await expect(validateWebhookUrl('ftp://example.com')).rejects.toThrow();
      await expect(validateWebhookUrl('file:///etc/passwd')).rejects.toThrow();
    });

    it('rejects malformed URLs', async () => {
      await expect(validateWebhookUrl('not a url')).rejects.toThrow();
    });

    it('accepts a public IP literal URL', async () => {
      await expect(
        validateWebhookUrl('https://8.8.8.8/hook'),
      ).resolves.toBeUndefined();
    });
  });

  describe('IsSafeWebhookUrlConstraint', () => {
    const c = new IsSafeWebhookUrlConstraint();

    it('rejects private/localhost/non-http URLs', () => {
      expect(c.validate('http://127.0.0.1/x')).toBe(false);
      expect(c.validate('http://localhost/x')).toBe(false);
      expect(c.validate('http://192.168.0.1/x')).toBe(false);
      expect(c.validate('ftp://example.com')).toBe(false);
      expect(c.validate('garbage')).toBe(false);
      expect(c.validate(123 as unknown as string)).toBe(false);
    });

    it('accepts public http(s) URLs', () => {
      expect(c.validate('https://example.com/webhook')).toBe(true);
      expect(c.validate('https://8.8.8.8/webhook')).toBe(true);
    });
  });
});

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let consumerService: jest.Mocked<Partial<ConsumerManagementService>>;
  let eventService: jest.Mocked<Partial<EventStorageService>>;

  const makeConsumer = (over: Partial<WebhookConsumer> = {}): WebhookConsumer =>
    ({
      id: 'consumer-1',
      name: 'c1',
      url: 'https://example.com/webhook',
      secret: 'topsecret',
      isActive: true,
      maxRetries: 5,
      timeoutMs: 5000,
      totalDeliveries: 0,
      failedDeliveries: 0,
      deliveryAttempts: 0,
      ...over,
    }) as WebhookConsumer;

  const makeEvent = (over: Partial<StellarEvent> = {}): StellarEvent =>
    ({
      id: 'event-1',
      eventType: EventType.PAYMENT,
      ledgerSequence: 1,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      transactionHash: 'hash',
      sourceAccount: 'acct',
      payload: { a: 1 },
      deliveryAttempts: 0,
      ...over,
    }) as StellarEvent;

  beforeEach(() => {
    jest.useFakeTimers();
    consumerService = {
      getActiveConsumers: jest.fn().mockResolvedValue([]),
      getConsumerById: jest.fn(),
      updateDeliveryStats: jest.fn().mockResolvedValue(undefined),
      recordDeliveryProgress: jest.fn().mockResolvedValue(undefined),
      getDecryptedSecret: jest.fn().mockResolvedValue('topsecret'),
    };
    eventService = {
      updateEventStatus: jest.fn().mockResolvedValue(undefined),
      markEventAsProcessed: jest.fn().mockResolvedValue(undefined),
      getPendingEvents: jest.fn().mockResolvedValue([]),
    };
    const queueMock = { add: jest.fn(), count: jest.fn().mockResolvedValue(0) };
    service = new WebhookDeliveryService(
      queueMock as any,
      consumerService as ConsumerManagementService,
      eventService as EventStorageService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('signature generation', () => {
    it('attaches an X-Stellara-Signature HMAC-SHA256 header', async () => {
      const consumer = makeConsumer();
      const event = makeEvent();
      const post = jest.fn().mockResolvedValue({ status: 200 });
      (service as any).httpClient = { post };

      const result = await (service as any).attemptDelivery(event, consumer, 1);

      expect(result.success).toBe(true);
      const [url, body, config] = post.mock.calls[0];
      expect(url).toBe(consumer.url);

      const expected = createHmac('sha256', consumer.secret)
        .update(body as string)
        .digest('hex');
      expect(config.headers[WebhookDeliveryService.SIGNATURE_HEADER]).toBe(
        expected,
      );
      expect(config.headers['X-Delivery-Attempt']).toBe('1');
      expect(config.headers['X-Idempotency-Key']).toBe('event-1:consumer-1');
    });

    it('omits the signature header when consumer has no secret', async () => {
      const consumer = makeConsumer({ secret: undefined });
      const post = jest.fn().mockResolvedValue({ status: 200 });
      (service as any).httpClient = { post };

      await (service as any).attemptDelivery(makeEvent(), consumer, 1);

      const config = post.mock.calls[0][2];
      expect(
        config.headers[WebhookDeliveryService.SIGNATURE_HEADER],
      ).toBeUndefined();
    });

    it('generateSignature is deterministic and matches crypto', () => {
      const sig = (service as any).generateSignature('payload', 'secret');
      expect(sig).toBe(
        createHmac('sha256', 'secret').update('payload').digest('hex'),
      );
    });
  });

  describe('backoff schedule', () => {
    it('follows 1s, 5s, 30s, 5m, 30m', () => {
      const delays = [1, 2, 3, 4, 5].map((a) =>
        (service as any).calculateBackoffDelay(a),
      );
      expect(delays).toEqual([1000, 5000, 30000, 300000, 1800000]);
    });
  });

  describe('retry escalation', () => {
    const failure = { success: false, errorMessage: 'boom' };

    it('schedules a retry with backoff when under the attempt cap', async () => {
      const consumer = makeConsumer();
      const event = makeEvent();

      await (service as any).handleFailedDelivery(event, consumer, failure, 1);

      // Records the attempt + error on the consumer, marks event RETRYING.
      expect(consumerService.recordDeliveryProgress).toHaveBeenCalledWith(
        'consumer-1',
        1,
        'boom',
      );
      expect(eventService.updateEventStatus).toHaveBeenCalledWith(
        'event-1',
        DeliveryStatus.RETRYING,
        'consumer-1',
        'boom',
      );
      // Bull handles retry scheduling — no dead-letter at attempt 1.
      expect(eventService.updateEventStatus).not.toHaveBeenCalledWith(
        expect.anything(),
        DeliveryStatus.DEAD_LETTER,
        expect.anything(),
        expect.anything(),
      );
    });

    it('moves to dead-letter after the 5th failed attempt', async () => {
      const consumer = makeConsumer();
      const event = makeEvent();

      await (service as any).handleFailedDelivery(event, consumer, failure, 5);

      expect(eventService.updateEventStatus).toHaveBeenCalledWith(
        'event-1',
        DeliveryStatus.DEAD_LETTER,
        'consumer-1',
        'boom',
      );
    });

    it('dead-letters immediately when the URL is unsafe (SSRF)', async () => {
      const consumer = makeConsumer({ url: 'http://169.254.169.254/' });
      consumerService.getConsumerById = jest.fn().mockResolvedValue(consumer);
      const event = makeEvent();

      await (service as any).deliverEventToConsumer(event, consumer, 1);

      expect(eventService.updateEventStatus).toHaveBeenCalledWith(
        'event-1',
        DeliveryStatus.DEAD_LETTER,
        'consumer-1',
        expect.any(String),
      );
    });
  });

  describe('idempotency / deduplication', () => {
    it('does not deliver the same event to the same consumer twice', async () => {
      const consumer = makeConsumer();
      consumerService.getConsumerById = jest.fn().mockResolvedValue(consumer);
      consumerService.getActiveConsumers = jest
        .fn()
        .mockResolvedValue([consumer]);
      const post = jest.fn().mockResolvedValue({ status: 200 });
      (service as any).httpClient = { post };
      const event = makeEvent();

      await (service as any).deliverEventToConsumer(event, consumer, 1);
      // Second call is a duplicate — must be skipped.
      await (service as any).deliverEventToConsumer(event, consumer, 1);

      expect(post).toHaveBeenCalledTimes(1);
    });
  });
});
