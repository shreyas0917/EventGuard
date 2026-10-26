import { Producer } from "kafkajs";
import { getKafka } from "../lib/kafka.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

let producer: Producer | null = null;

export async function initializeProducer(): Promise<void> {
  if (producer) {
    logger.debug("Producer already initialized");
    return;
  }

  const kafka = getKafka();
  producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
  });

  await producer.connect();
  logger.info("[Kafka] Producer connected");
}

export async function publishEvent(eventId: string, eventType: string, payload: any): Promise<void> {
  if (!producer) {
    throw new Error("Producer not initialized. Call initializeProducer() first.");
  }

  const message = {
    eventId,
    eventType,
    payload,
  };

  try {
    const result = await producer.send({
      topic: config.kafka_topic,
      messages: [
        {
          key: eventId,
          value: JSON.stringify(message),
        },
      ],
    });

    logger.info(`[Kafka] Published event: ${eventId} to partition ${result[0].partition}`);
  } catch (error) {
    logger.error(`[Kafka] Failed to publish event ${eventId}`, error);
    throw error;
  }
}

export interface OutgoingEvent {
  eventId: string;
  eventType: string;
  payload: any;
}

/**
 * Publish several events in one produce request. Keyed by eventId, so every copy of
 * an event lands on the same partition. All-or-nothing from the caller's view: on
 * error the whole batch is treated as unpublished and retried.
 */
export async function publishEvents(events: OutgoingEvent[]): Promise<void> {
  if (!producer) {
    throw new Error("Producer not initialized. Call initializeProducer() first.");
  }
  if (events.length === 0) return;

  await producer.send({
    topic: config.kafka_topic,
    messages: events.map((event) => ({
      key: event.eventId,
      value: JSON.stringify({ eventId: event.eventId, eventType: event.eventType, payload: event.payload }),
    })),
  });
}

export async function disconnectProducer(): Promise<void> {
  if (!producer) {
    logger.debug("Producer not initialized, nothing to disconnect");
    return;
  }

  try {
    await producer.disconnect();
    producer = null;
    logger.info("[Kafka] Producer disconnected");
  } catch (error) {
    logger.error("[Kafka] Error disconnecting producer", error);
  }
}

export function isProducerConnected(): boolean {
  return producer !== null;
}
