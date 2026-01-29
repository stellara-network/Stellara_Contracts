export function buildRateKey(prefix: string, identifier: string): string {
  return `rate:${prefix}:${identifier}`;
}

export function buildBanKey(identifier: string): string {
  return `ban:${identifier}`;
}
