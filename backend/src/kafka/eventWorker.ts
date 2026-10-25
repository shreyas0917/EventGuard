import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { acquireLock, releaseLock } from "../services/redisLockService.js";
import {
  markEventCompletedInCache,
  isEventCompletedInCache,
} from "../services/redisIdempotencyCache.js";
import {
  claimEventForProcessing,
  markEventAsCompleted,
  recordDuplicateDelivery,
} from "../services/eventClaimService.js";
import { creditWallet } from "../services/walletService.js";
import { handleProcessingFailure, shouldProcessFailSimulation } from "../services/retryService.js";
import { config } from "../config/index.js";

export interface KafkaEvent {
  eventId: string;
  eventType: string;
  payload: any;
}

const PROCESSING_DELAY_MS = parseInt(process.env.PROCESSING_DELAY_MS || "0", 10);

export async function processEvent(kafkaMessage: KafkaEvent): Promise<void> {
  const { eventId, eventType, payload } = kafkaMessage;

  try {
    logger.info(`[Worker] Received event: ${eventId}`);

    // STEP 1: Fast check using Redis cache (optimization only)
    const cachedAsCompleted = await isEventCompletedInCache(eventId);
    if (cachedAsCompleted) {
      logger.info(`[Worker] Event in Redis completed cache: ${eventId}`);
      await recordDuplicateDelivery(
        eventId,
        "Duplicate delivery - found in completed cache"
      );
      return;
    }

    // STEP 2: Try to acquire Redis lock
    // This prevents concurrent processing by multiple workers.
    // Redis infrastructure failures throw RedisLockError (must not be treated as contention).
    const lockHandle = await acquireLock(eventId);

    if (!lockHandle.acquired) {
      logger.info(
        `[Worker] Redis lock contention for ${eventId} - another worker holds the lock`
      );
      await recordDuplicateDelivery(
        eventId,
        "Concurrent processing detected - Redis lock unavailable"
      );
      // Normal contention: do not process. Offset may commit; the lock holder owns the work.
      return;
    }

    try {
      // STEP 3: Attempt to claim the event in PostgreSQL
      // This is the final idempotency guarantee
      const claimResult = await claimEventForProcessing(eventId);

      if (claimResult === "already-completed") {
        logger.info(`[Worker] Event already completed: ${eventId}`);
        await recordDuplicateDelivery(eventId, "Duplicate - already completed");
        // Update cache
        await markEventCompletedInCache(eventId);
        return;
      }

      if (claimResult === "already-processing") {
        logger.info(`[Worker] Event already processing: ${eventId}`);
        await recordDuplicateDelivery(
          eventId,
          "Duplicate - another worker processing"
        );
        return;
      }

      if (claimResult === "not-found") {
        logger.warn(`[Worker] Event not found: ${eventId}`);
        return;
      }

      if (claimResult === "already-failed") {
        logger.info(`[Worker] Event already failed: ${eventId}`);
        await recordDuplicateDelivery(eventId, "Event previously failed");
        return;
      }

      // STEP 4: Event has been claimed for processing
      if (claimResult !== "claimed") {
        logger.error(`[Worker] Unexpected claim result: ${claimResult}`);
        return;
      }

      logger.info(`[Worker] Event claimed for processing: ${eventId}`);

      // Add EventLog entry for PROCESSING
      await prisma.eventLog.create({
        data: {
          eventId,
          status: "PROCESSING",
          message: "Event processing started",
        },
      });

      // STEP 5: Process the event based on type
      logger.info(`[Worker] Processing event: ${eventId} (type: ${eventType})`);

      // Check for test failure simulation
      if (await shouldProcessFailSimulation(eventId)) {
        throw new Error("Intentional failure simulation for testing retry mechanism");
      }

      // Handle PAYMENT_SUCCESS events with wallet credit business logic
      if (eventType === "PAYMENT_SUCCESS") {
        await handlePaymentSuccessEvent(eventId, payload);
      }

      // Simulate processing with optional delay for testing
      await simulateProcessing(PROCESSING_DELAY_MS);

      // STEP 6: Mark as completed in database
      const now = new Date();
      await markEventAsCompleted(eventId, now);

      // Add EventLog entry for COMPLETED
      await prisma.eventLog.create({
        data: {
          eventId,
          status: "COMPLETED",
          message: "Event processing completed",
        },
      });

      // STEP 7: Mark as completed in Redis cache
      await markEventCompletedInCache(eventId);

      logger.info(`[Worker] Event completed: ${eventId}`);
    } catch (error) {
      // STEP 5B: Handle processing failure
      const event = await prisma.event.findUnique({
        where: { eventId },
      });

      if (!event) {
        logger.error(`[Worker] Event not found during error handling: ${eventId}`);
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const attemptCount = event.attemptCount;
      const maxAttempts = event.maxAttempts;

      logger.error(
        `[Worker] Processing failed for ${eventId} on attempt ${attemptCount}/${maxAttempts}: ${errorMessage}`
      );

      try {
        await handleProcessingFailure(eventId, errorMessage, attemptCount, maxAttempts, eventType, payload);
      } catch (retryError) {
        logger.error(`[Worker] Error handling processing failure for ${eventId}`, retryError);
      }

      // Don't re-throw - let the system handle this failure
      // Re-throwing would cause Kafka to redeliver, which we don't want
      // We want the application-level retry mechanism to take over
    } finally {
      // STEP 8: Always release the lock (if acquired)
      await releaseLock(lockHandle);
    }
  } catch (error) {
    logger.error(`[Worker] Unexpected error processing event ${eventId}`, error);
    throw error;
  }
}

async function simulateProcessing(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    logger.debug(`[Worker] Processing delay: ${delayMs}ms`);
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Minimal delay to represent work
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function handlePaymentSuccessEvent(eventId: string, payload: any): Promise<void> {
  const { userId, paymentId, orderId, amount } = payload;

  if (!userId || !paymentId || !orderId || !amount) {
    logger.error(`[Worker] Invalid PAYMENT_SUCCESS payload for ${eventId}`, payload);
    throw new Error(`Invalid PAYMENT_SUCCESS payload for ${eventId}`);
  }

  logger.info(`[Worker] Processing payment ${paymentId} for user ${userId}, amount: ${amount}`);

  try {
    // Credit wallet with atomic transaction - UNIQUE constraint protects against duplicates
    const result = await creditWallet(userId, amount, eventId, "Payment received");

    logger.info(
      `[Worker] Wallet credited: ${result.walletTransaction.id}, ` +
      `new balance: ${result.wallet.balance}`
    );

    // Add EventLog entry for wallet credit
    await prisma.eventLog.create({
      data: {
        eventId,
        status: "WALLET_CREDITED",
        message: `Wallet credited: ${amount}, transaction: ${result.walletTransaction.id}`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      // UNIQUE constraint violation means duplicate event
      logger.info(`[Worker] Duplicate payment event ${eventId} - WalletTransaction.eventId UNIQUE constraint`);
      await recordDuplicateDelivery(eventId, "Duplicate - WalletTransaction.eventId UNIQUE constraint");
    } else {
      logger.error(`[Worker] Failed to credit wallet for event ${eventId}`, error);
      throw error;
    }
  }
}
