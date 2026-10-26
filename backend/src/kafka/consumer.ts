import { Consumer, EachMessagePayload } from "kafkajs";
import { getKafka } from "../lib/kafka.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import { processEvent } from "./eventWorker.js";

let consumer: Consumer | null = null;

export interface EventConsumerOptions {
  groupId?: string;
  topic?: string;
  fromBeginning?: boolean;
}

/**
 * Create, connect and subscribe a consumer that runs every message through
 * processEvent(). The app runs one; tests create several to simulate competing
 * deployments. Call run() on the result to start consuming.
 */
export async function createEventConsumer(options: EventConsumerOptions = {}): Promise<Consumer> {
  const groupId = options.groupId ?? config.kafka_consumer_group;
  const topic = options.topic ?? config.kafka_topic;

  const kafka = getKafka();
  const created = kafka.consumer({
    groupId,
    sessionTimeout: config.kafka_session_timeout_ms,
    rebalanceTimeout: 60000,
  });

  await created.connect();
  await created.subscribe({ topic, fromBeginning: options.fromBeginning ?? config.kafka_from_beginning });
  logger.info(`[Kafka] Consumer in group ${groupId} subscribed to ${topic}`);
  return created;
}

export async function runEventConsumer(target: Consumer): Promise<void> {
  await target.run({
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
}

export async function initializeConsumer(): Promise<void> {
  if (consumer) {
    logger.debug("Consumer already initialized");
    return;
  }

  consumer = await createEventConsumer();
  logger.info("[Kafka] Consumer connected");
}

export async function subscribeToEvents(): Promise<void> {
  if (!consumer) {
    throw new Error("Consumer not initialized. Call initializeConsumer() first.");
  }
  // Subscription happens in createEventConsumer(); kept for the worker's lifecycle API.
}

export async function startConsumer(): Promise<void> {
  if (!consumer) {
    throw new Error("Consumer not initialized. Call initializeConsumer() first.");
  }

  await runEventConsumer(consumer);
  logger.info("[Kafka] Consumer started processing messages");
}

export async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const { partition, message } = payload;

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
