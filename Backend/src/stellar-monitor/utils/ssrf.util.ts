import { isIP } from 'net';
import { lookup } from 'dns/promises';

/**
 * SSRF protection helpers for outbound webhook URLs.
 *
 * Consumer-supplied URLs are attacker-controlled. Without validation a consumer
 * could point a webhook at an internal service (cloud metadata endpoint, an
 * internal admin API, etc.) and have our server make the request on its behalf.
 * We therefore reject any URL that resolves to a private, loopback, link-local
 * or otherwise reserved address.
 */

/** Hostnames that always map to the local machine. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * Returns true if the given IP literal (v4 or v6) is private, loopback,
 * link-local, or otherwise non-routable on the public internet.
 */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  // Not a valid IP literal — caller must resolve it first.
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return true; // malformed — treat as unsafe
  }
  const [a, b] = parts;

  // 0.0.0.0/8 — "this" network
  if (a === 0) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 & 192.0.2.0/24 — IETF/TEST-NET-1
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  if (a >= 224) return true;

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // strip zone id

  // Loopback ::1 and unspecified ::
  if (addr === '::1' || addr === '::') return true;
  // Unique local fc00::/7
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;
  // Link-local fe80::/10
  if (
    addr.startsWith('fe8') ||
    addr.startsWith('fe9') ||
    addr.startsWith('fea') ||
    addr.startsWith('feb')
  ) {
    return true;
  }
  // IPv4-mapped ::ffff:a.b.c.d — re-check embedded v4
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isPrivateIpv4(mapped[1]);
  }

  return false;
}

/**
 * Validates that a webhook URL is safe to call. Throws an Error with a
 * descriptive message when the URL is malformed, uses a non-HTTP(S) scheme,
 * or resolves to a private/internal address.
 *
 * Resolves the hostname via DNS to defend against DNS-rebinding where a public
 * name points at a private IP.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid webhook URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported webhook URL scheme: ${url.protocol}`);
  }

  // Strip brackets from IPv6 literals (e.g. [::1]).
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`Webhook URL points to a blocked host: ${hostname}`);
  }

  // IP literal — check directly without DNS.
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Webhook URL resolves to a private address: ${hostname}`);
    }
    return;
  }

  // Hostname — resolve every address and reject if any is private.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Unable to resolve webhook host: ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Webhook URL resolves to a private address: ${address} (${hostname})`,
      );
    }
  }
}
