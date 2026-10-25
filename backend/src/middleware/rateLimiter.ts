import { Request, Response, NextFunction } from "express";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

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

export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60, // 60 webhooks per minute (allow Razorpay retries)
  keyGenerator: (req: Request) => "webhook",
});

/**
 * Clean up old rate limit entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000); // Clean every minute