import 'server-only';

/**
 * In-process sliding-window rate limiter for the AI endpoint.
 *
 * Deliberately simple: a Map in the Node process. That is correct for a single
 * instance and for local development, and it is honest about its limits — on a
 * multi-instance deployment each instance enforces its own window, so the
 * effective limit multiplies by the instance count. Swap the store for Redis
 * or Upstash before scaling horizontally; the call site does not change.
 */

interface Window {
  hits: number[];
}

const WINDOWS = new Map<string, Window>();
const SWEEP_AFTER = 5_000;
let sinceSweep = 0;

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  /** Seconds until the caller may retry. Only meaningful when blocked. */
  retryAfter: number;
  limit: number;
}

export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitVerdict {
  const now = Date.now();
  const cutoff = now - rule.windowMs;

  sweepOccasionally(now);

  const window = WINDOWS.get(key) ?? { hits: [] };
  const hits = window.hits.filter((timestamp) => timestamp > cutoff);

  if (hits.length >= rule.limit) {
    const oldest = hits[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
    WINDOWS.set(key, { hits });
    return { allowed: false, remaining: 0, retryAfter, limit: rule.limit };
  }

  hits.push(now);
  WINDOWS.set(key, { hits });

  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - hits.length),
    retryAfter: 0,
    limit: rule.limit,
  };
}

/** Keeps the Map from growing without bound on a long-lived process. */
function sweepOccasionally(now: number): void {
  sinceSweep += 1;
  if (sinceSweep < SWEEP_AFTER) return;
  sinceSweep = 0;

  const horizon = now - 60 * 60 * 1000;
  for (const [key, window] of WINDOWS) {
    const live = window.hits.filter((timestamp) => timestamp > horizon);
    if (live.length === 0) WINDOWS.delete(key);
    else WINDOWS.set(key, { hits: live });
  }
}

export const AI_CHAT_LIMITS = {
  /** Per identity — a signed-in user or a guest AI session cookie. */
  perSession: { limit: 20, windowMs: 60_000 } as RateLimitRule,
  /** Per IP, to blunt cookie-cycling. */
  perIp: { limit: 40, windowMs: 60_000 } as RateLimitRule,
} as const;

export const MAX_MESSAGE_LENGTH = 1_000;
export const MAX_REQUEST_BYTES = 8 * 1024;
