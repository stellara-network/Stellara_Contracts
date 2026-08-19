import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Encrypts and decrypts webhook consumer secrets at rest using AES-256-GCM.
 * The encryption key is read from the WEBHOOK_SECRET_KEY environment variable
 * (32-byte hex string, i.e. 64 hex characters).
 *
 * Stored format: `<iv_hex>:<tag_hex>:<ciphertext_hex>`
 */
@Injectable()
export class WebhookSecretService {
  private readonly key: Buffer;

  constructor() {
    const raw = process.env.WEBHOOK_SECRET_KEY ?? '';
    if (!raw || raw.length !== 64) {
      throw new Error(
        'WEBHOOK_SECRET_KEY must be a 64-character hex string (32 bytes). ' +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    this.key = Buffer.from(raw, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  decrypt(stored: string): string {
    const parts = stored.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted secret format');
    }
    const [ivHex, tagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return (
      decipher.update(ciphertext).toString('utf8') +
      decipher.final().toString('utf8')
    );
  }

  /** Sign a payload with the given (plaintext) secret using HMAC-SHA256. */
  sign(payload: string, plaintextSecret: string): string {
    return createHmac('sha256', plaintextSecret).update(payload).digest('hex');
  }
}
