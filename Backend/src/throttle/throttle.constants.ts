export const RATE_LIMITS = {
  GLOBAL: { limit: 100, window: 60 }, // per IP
  AUTH: { limit: 5, window: 60 }, // login/register
  MARKET: { limit: 60, window: 60 },
  CHAT: { limit: 30, window: 60 },
};

export const BAN_RULES = {
  MAX_VIOLATIONS: 3,
  BASE_BAN_SECONDS: 60, // exponential
};
