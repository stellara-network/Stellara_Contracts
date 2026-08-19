import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * Describes one rotation event fired by SecretsRotationService.
 */
export interface SecretRotatedEvent {
  /** Canonical name of the secret that was rotated (e.g. 'JWT_SECRET'). */
  secretKey: string;
  /** ISO timestamp of the rotation. */
  rotatedAt: string;
  /** Optional human-readable reason / source (e.g. 'vault-renewal', 'manual'). */
  reason?: string;
}

/**
 * Type-safe callback registered by consumers.
 */
export type RotationHandler = (
  event: SecretRotatedEvent,
) => void | Promise<void>;

/**
 * SecretsRotationService
 *
 * Provides a lightweight, in-process event bus for secret-rotation signals.
 * Any part of the application can:
 *   1. **Register** a handler that runs when a given secret is rotated.
 *   2. **Trigger** a rotation notification (called by Vault renewer, cron, or
 *      an HTTP endpoint accessible only to operators).
 *
 * The service does NOT pull secrets from Vault itself – it only broadcasts the
 * signal.  The caller that detects a new secret version should call
 * `notifyRotation()` after updating the relevant in-memory values.
 *
 * Example (consumer):
 * ```ts
 * rotationService.onRotation('JWT_SECRET', async (evt) => {
 *   // Reload the new JWT_SECRET from process.env / config service
 *   await jwtAuthService.reloadSigningKey();
 *   logger.log(`JWT_SECRET reloaded at ${evt.rotatedAt}`);
 * });
 * ```
 *
 * Example (trigger from Vault renewer or HTTP endpoint):
 * ```ts
 * process.env['JWT_SECRET'] = newValue;          // already updated by loader
 * rotationService.notifyRotation('JWT_SECRET', 'vault-renewal');
 * ```
 */
@Injectable()
export class SecretsRotationService
  extends EventEmitter
  implements OnModuleInit
{
  private readonly logger = new Logger(SecretsRotationService.name);

  /** Registry of handlers keyed by secret name for quick lookup. */
  private readonly handlers = new Map<string, RotationHandler[]>();

  onModuleInit(): void {
    this.logger.log(
      'SecretsRotationService initialised — rotation hooks ready',
    );
  }

  /**
   * Register a callback that fires whenever `secretKey` is rotated.
   * Multiple handlers may be registered for the same key.
   *
   * @param secretKey   The canonical env-var name, e.g. `'JWT_SECRET'`.
   * @param handler     Async-safe callback invoked with the rotation event.
   * @returns           An unsubscribe function that removes this handler.
   */
  onRotation(secretKey: string, handler: RotationHandler): () => void {
    const existing = this.handlers.get(secretKey) ?? [];
    existing.push(handler);
    this.handlers.set(secretKey, existing);

    this.logger.debug(`Rotation handler registered for: ${secretKey}`);

    return () => {
      const current = this.handlers.get(secretKey) ?? [];
      this.handlers.set(
        secretKey,
        current.filter((h) => h !== handler),
      );
      this.logger.debug(`Rotation handler removed for: ${secretKey}`);
    };
  }

  /**
   * Broadcast a rotation event for `secretKey` to all registered handlers.
   *
   * Call this **after** the new secret value is already loaded into the
   * environment / config layer.
   *
   * @param secretKey   The canonical env-var name that was rotated.
   * @param reason      Optional context (e.g. `'vault-renewal'`, `'manual'`).
   */
  async notifyRotation(secretKey: string, reason?: string): Promise<void> {
    const event: SecretRotatedEvent = {
      secretKey,
      rotatedAt: new Date().toISOString(),
      reason,
    };

    this.logger.log(
      `Secret rotated: ${secretKey}${reason ? ` (reason: ${reason})` : ''}`,
    );

    const registeredHandlers = this.handlers.get(secretKey) ?? [];

    if (registeredHandlers.length === 0) {
      this.logger.warn(
        `No rotation handlers registered for secret: ${secretKey}`,
      );
      return;
    }

    await Promise.all(
      registeredHandlers.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          // Handlers must not crash the rotation broadcast
          this.logger.error(
            `Rotation handler error for ${secretKey}: ${(err as Error).message}`,
          );
        }
      }),
    );

    // Also emit on the EventEmitter bus for any direct `.on()` listeners
    this.emit('rotation', event);
  }

  /**
   * Bulk-notify multiple secrets at once (useful at startup or after a
   * Vault batch-renewal).
   *
   * @param secretKeys  Array of canonical env-var names.
   * @param reason      Optional shared reason string.
   */
  async notifyBulkRotation(
    secretKeys: string[],
    reason?: string,
  ): Promise<void> {
    for (const key of secretKeys) {
      await this.notifyRotation(key, reason);
    }
  }

  /**
   * Returns the list of secret keys that have at least one handler.
   */
  registeredSecrets(): string[] {
    return Array.from(this.handlers.keys());
  }
}
