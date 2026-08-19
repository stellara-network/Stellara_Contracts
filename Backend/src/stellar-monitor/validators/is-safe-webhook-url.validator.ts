import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isIP } from 'net';
import { isPrivateIp } from '../utils/ssrf.util';

/**
 * Synchronous, IP-literal-level SSRF guard for DTO validation.
 *
 * This gives fast feedback at the API boundary by rejecting obvious offenders
 * (localhost, private IP literals, non-HTTP schemes). Full DNS-resolution
 * checks happen at delivery time via {@link validateWebhookUrl}, since DNS is
 * async and can change between registration and delivery (rebinding).
 */
@ValidatorConstraint({ name: 'isSafeWebhookUrl', async: false })
export class IsSafeWebhookUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost'))
      return false;

    if (isIP(hostname) && isPrivateIp(hostname)) return false;

    return true;
  }

  defaultMessage(): string {
    return 'url must be a public http(s) URL and must not point to a private or internal address';
  }
}

export function IsSafeWebhookUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsSafeWebhookUrlConstraint,
    });
  };
}
