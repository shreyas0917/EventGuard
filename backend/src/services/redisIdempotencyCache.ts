import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

const COMPLETED_PREFIX = "eventguard:completed:";
const DEFAULT_COMPLETED_TTL_SECONDS = 86400; // 24 hours

export async function markEventCompletedInCache(
  eventId: string,
  ttlSeconds: number = DEFAULT_COMPLETED_TTL_SECONDS
): Promise<void> {
  try {
    const redisClient = getRedis();
    const key = `${COMPLETED_PREFIX}${eventId}`;
    await redisClient.setex(key, ttlSeconds, "true");
    logger.debug(`[Redis] Marked ${eventId} as completed in cache`);
  } catch (error) {
    logger.warn(`[Redis] Error marking ${eventId} as completed`, error);
    // If Redis is down, continue - PostgreSQL is source of truth
  }
}

export async function isEventCompletedInCache(eventId: string): Promise<boolean> {
  try {
    const redisClient = getRedis();
    const key = `${COMPLETED_PREFIX}${eventId}`;
    const value = await redisClient.get(key);
    return value !== null;
  } catch (error) {
    logger.debug(`[Redis] Error checking completed cache for ${eventId}`, error);
    // If Redis is down, return false - will check database
    return false;
  }
}

export async function clearEventCompletedCache(eventId: string): Promise<void> {
  try {
    const redisClient = getRedis();
    const key = `${COMPLETED_PREFIX}${eventId}`;
    await redisClient.del(key);
    logger.debug(`[Redis] Cleared completed cache for ${eventId}`);
  } catch (error) {
    logger.warn(`[Redis] Error clearing completed cache for ${eventId}`, error);
  }
}
