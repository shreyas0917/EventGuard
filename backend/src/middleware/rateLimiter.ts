import { Request, Response, NextFunction } from "express";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// One store per limiter, so a request counted by the general /api limiter is not
// also counted against a stricter route limiter that shares the same client key.
const limiterStores: Map<string, RateLimitEntry>[] = [];

/**
 * Simple in-memory rate limiting middleware
 *
 * For production, consider using Redis-based rate limiting
 * This is a basic implementation that works for single-instance deployments
 */
export function rateLimit(options?: {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
}) {
  const windowMs = options?.windowMs || config.rate_limit_window_ms;
  const maxRequests = options?.maxRequests || config.rate_limit_max_requests;
  const keyGenerator = options?.keyGenerator || ((req: Request) => req.ip || "unknown");
  const rateLimitStore = new Map<string, RateLimitEntry>();
  limiterStores.push(rateLimitStore);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyGenerator(req);
    const now = Date.now();

    let entry = rateLimitStore.get(key);

    // Reset if window expired
    if (!entry || now > entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    entry.count++;
    rateLimitStore.set(key, entry);

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - entry.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      logger.warn(`[RateLimit] Too many requests from ${key}`);
      res.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
        },
      });
      return;
    }

    next();
  };
}

/**
 * Rate limiter for specific endpoints
 */
export const strictRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute
});

export const authRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // slows down admin-key guessing on demo login
});

// Per sender IP, not one global bucket: a single shared key capped ALL webhooks at
// 60/min, i.e. one payment per second. Authenticity is enforced by HMAC; this is only
// abuse protection, so the default leaves room for real payment bursts.
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: config.webhook_rate_limit_max_requests,
});

/**
 * Clean up old rate limit entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const store of limiterStores) {
    for (const [key, entry] of store.entries()) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }
}, 60 * 1000).unref(); // Clean every minute; never keep the process alive