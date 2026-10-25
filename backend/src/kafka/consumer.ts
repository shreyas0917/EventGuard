import { Consumer, EachMessagePayload } from "kafkajs";
import { getKafka } from "../lib/kafka.js";
import { logger } from "../lib/logger.js";
import { processEvent } from "./eventWorker.js";

let consumer: Consumer | null = null;

export async function initializeConsumer(): Promise<void> {
  if (consumer) {
    logger.debug("Consumer already initialized");
    return;
  }

  const kafka = getKafka();
  consumer = kafka.consumer({
    groupId: "eventguard-workers",
    sessionTimeout: 30000,
    rebalanceTimeout: 60000,
  });

  await consumer.connect();
  logger.info("[Kafka] Consumer connected");
}

export async function subscribeToEvents(): Promise<void> {
  if (!consumer) {
    throw new Error("Consumer not initialized. Call initializeConsumer() first.");
  }

  await consumer.subscribe({ topic: "eventguard.events" });
  logger.info("[Kafka] Consumer subscribed to eventguard.events");
}

export async function startConsumer(): Promise<void> {
  if (!consumer) {
    throw new Error("Consumer not initialized. Call initializeConsumer() first.");
  }

  await consumer.run({
    eachMessage: async (payload: EachMessagePayload) => {
      try {
        await handleMessage(payload);
      } catch (error) {
        logger.error("[Kafka] Error handling message — rethrowing to avoid offset commit", error);
        // KafkaJS commits the offset only when eachMessage resolves successfully.
        // Rethrow so infrastructure failures (e.g. RedisLockError) keep the message eligible for redelivery.
        throw error;
      }
    },
  });

  logger.info("[Kafka] Consumer started processing messages");
}

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const { topic, partition, message } = payload;

  if (!message.value || !message.key) {
    logger.warn("[Kafka] Received message without value or key");
    return;
  }

  const eventId = message.key.toString();

  try {
    const messageBody = JSON.parse(message.value.toString());

    // Validate required fields
    if (!messageBody.eventId || !messageBody.eventType) {
      logger.error("[Kafka] Invalid message format - missing eventId or eventType", messageBody);
      // Skip invalid messages without committing - they'll be retried
      return;
    }

    logger.info(`[Kafka] Received event: ${eventId} from partition ${partition}`);

    // Process the event
    await processEvent(messageBody);

    logger.debug(`[Kafka] Successfully processed event: ${eventId}`);

    // Offset is committed automatically by KafkaJS after eachMessage returns successfully
    // If eachMessage throws, the offset is NOT committed and the message will be redelivered
    // This ensures at-least-once delivery semantics
  } catch (error) {
    logger.error(`[Kafka] Failed to process message for event: ${eventId}`, error);
    // Re-throw to prevent offset commit
    throw error;
  }
}

export async function disconnectConsumer(): Promise<void> {
  if (!consumer) {
    logger.debug("Consumer not initialized, nothing to disconnect");
    return;
  }

  try {
    await consumer.disconnect();
    consumer = null;
    logger.info("[Kafka] Consumer disconnected");
  } catch (error) {
    logger.error("[Kafka] Error disconnecting consumer", error);
  }
}

export function isConsumerConnected(): boolean {
  return consumer !== null;
}
