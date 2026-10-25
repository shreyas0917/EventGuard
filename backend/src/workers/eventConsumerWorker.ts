import { initializeConsumer, subscribeToEvents, startConsumer, disconnectConsumer } from "../kafka/consumer.js";
import { logger } from "../lib/logger.js";

let isRunning = false;

export async function startEventConsumer(): Promise<void> {
  if (isRunning) {
    logger.warn("[Worker] Event consumer is already running");
    return;
  }

  try {
    logger.info("[Worker] Starting event consumer");
    isRunning = true;

    // Initialize consumer
    await initializeConsumer();

    // Subscribe to topic
    await subscribeToEvents();

    // Start processing messages
    await startConsumer();

    logger.info("[Worker] Event consumer started successfully");
  } catch (error) {
    logger.error("[Worker] Failed to start event consumer", error);
    isRunning = false;
    throw error;
  }
}

export async function stopEventConsumer(): Promise<void> {
  if (!isRunning) {
    logger.warn("[Worker] Event consumer is not running");
    return;
  }

  try {
    logger.info("[Worker] Stopping event consumer");
    await disconnectConsumer();
    isRunning = false;
    logger.info("[Worker] Event consumer stopped");
  } catch (error) {
    logger.error("[Worker] Error stopping event consumer", error);
  }
}

export function isEventConsumerRunning(): boolean {
  return isRunning;
}
