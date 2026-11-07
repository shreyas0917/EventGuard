import { Consumer, EachBatchPayload, KafkaMessage } from "kafkajs";
import { getKafka } from "../lib/kafka.js";
import { logger, withLogContext } from "../lib/logger.js";
import { config } from "../config/index.js";
import { processEvent } from "./eventWorker.js";
import { kafkaInvalidMessages } from "../lib/metrics.js";

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

/**
 * Consume with bounded concurrency while keeping at-least-once semantics.
 *
 * Each event is ~15 sequential Redis/PostgreSQL round trips, so one message at a time
 * sustained 12 events/s in the load test, against 66 events/s with the defaults below
 * (same machine and load; docs/PERFORMANCE.md). All partitions are consumed in
 * parallel, and each partition's batch is processed in concurrent chunks. Offsets
 * are resolved strictly in order and only up to the first failure: the failed message
 * and everything after it are redelivered. Re-running a message that had succeeded is
 * safe, because every effect is idempotent. Events of one batch are independent
 * entities (the guards are per event), so running them concurrently is sound.
 */
export async function runEventConsumer(target: Consumer): Promise<void> {
  await target.run({
    partitionsConsumedConcurrently: config.kafka_partitions_concurrency,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }: EachBatchPayload) => {
      const chunkSize = config.kafka_processing_concurrency;

      for (let start = 0; start < batch.messages.length; start += chunkSize) {
        if (!isRunning() || isStale()) return;

        const chunk = batch.messages.slice(start, start + chunkSize);
        const results = await Promise.allSettled(
          chunk.map((message) =>
            withLogContext(
              { eventId: message.key?.toString(), partition: batch.partition, offset: message.offset },
              () => handleMessage({ partition: batch.partition, message })
            )
          )
        );

        for (let i = 0; i < chunk.length; i++) {
          const result = results[i];
          if (result.status === "rejected") {
            // Commit what succeeded before it, then rethrow: KafkaJS redelivers from this
            // offset, so infrastructure failures (e.g. RedisLockError) are retried, not lost.
            await commitOffsetsIfNecessary();
            logger.error("[Kafka] Error handling message — offset left uncommitted for redelivery", result.reason);
            throw result.reason;
          }
          resolveOffset(chunk[i].offset);
        }

        await heartbeat();
        await commitOffsetsIfNecessary();
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

export async function handleMessage(payload: { partition: number; message: KafkaMessage }): Promise<void> {
  const { partition, message } = payload;

  // A poison message can never be processed, so we drop it (letting its offset commit) and
  // count it. Rethrowing would make KafkaJS redeliver it forever and block the partition.
  if (!message.value || !message.key) {
    logger.error("[Kafka] Poison message dropped: missing key or value", { partition });
    kafkaInvalidMessages.inc({ reason: "missing_key_or_value" });
    return;
  }

  const eventId = message.key.toString();

  let messageBody: any;
  try {
    messageBody = JSON.parse(message.value.toString());
  } catch (error) {
    logger.error(`[Kafka] Poison message dropped: invalid JSON for ${eventId}`, error);
    kafkaInvalidMessages.inc({ reason: "invalid_json" });
    return;
  }

  if (!messageBody.eventId || !messageBody.eventType) {
    logger.error("[Kafka] Poison message dropped: missing eventId or eventType", { eventId, partition });
    kafkaInvalidMessages.inc({ reason: "missing_fields" });
    return;
  }

  try {
    logger.info(`[Kafka] Received event: ${eventId} from partition ${partition}`);

    // Process the event
    await processEvent(messageBody);

    logger.debug(`[Kafka] Successfully processed event: ${eventId}`);

    // The offset is resolved by runEventConsumer only after this resolves; a throw keeps
    // this message (and the rest of its chunk) eligible for redelivery: at-least-once.
  } catch (error) {
    // A transient/infrastructure failure (Redis, PostgreSQL): rethrow so the offset is NOT
    // committed and the message is redelivered. Poison messages were already handled above.
    logger.error(`[Kafka] Failed to process message for event: ${eventId}`, error);
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
