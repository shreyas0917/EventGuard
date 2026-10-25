import { Kafka } from "kafkajs";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let kafka: Kafka | null = null;

export async function connectKafka() {
  try {
    kafka = new Kafka({
      clientId: "eventguard-api",
      brokers: config.kafka_brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    const admin = kafka.admin();
    await admin.connect();
    await admin.disconnect();

    logger.info("Kafka connected successfully");
    return true;
  } catch (error) {
    logger.error("Kafka connection failed", error);
    return false;
  }
}

export function getKafka() {
  if (!kafka) {
    throw new Error("Kafka not connected");
  }
  return kafka;
}

export async function closeKafka() {
  // KafkaJS client doesn't need explicit close for producer/consumer
  // that weren't created in this module
  logger.info("Kafka client reference cleared");
}
