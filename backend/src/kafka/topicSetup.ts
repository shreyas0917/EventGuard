import { getKafka } from "../lib/kafka.js";
import { logger } from "../lib/logger.js";

const TOPIC_NAME = "eventguard.events";
const NUM_PARTITIONS = 3;
const REPLICATION_FACTOR = 1;

export async function ensureTopicExists(): Promise<void> {
  try {
    const kafka = getKafka();
    const admin = kafka.admin();

    await admin.connect();
    logger.info("[Kafka] Admin connected");

    try {
      // Check if topic exists by listing all topics
      const topics = await admin.listTopics();

      if (topics.includes(TOPIC_NAME)) {
        logger.info(`[Kafka] Topic ${TOPIC_NAME} already exists`);
        await admin.disconnect();
        return;
      }
    } catch (error: any) {
      logger.debug("[Kafka] Error listing topics, proceeding to create", error.message);
    }

    // Create topic
    try {
      await admin.createTopics({
        topics: [
          {
            topic: TOPIC_NAME,
            numPartitions: NUM_PARTITIONS,
            replicationFactor: REPLICATION_FACTOR,
          },
        ],
        validateOnly: false,
        timeout: 30000,
      });

      logger.info(
        `[Kafka] Topic ${TOPIC_NAME} created (partitions: ${NUM_PARTITIONS}, replication: ${REPLICATION_FACTOR})`
      );
    } catch (createError: any) {
      // Topic might already exist, this is OK
      if (createError.message && createError.message.includes("TOPIC_ALREADY_EXISTS")) {
        logger.info(`[Kafka] Topic ${TOPIC_NAME} already exists`);
      } else {
        throw createError;
      }
    }

    await admin.disconnect();
  } catch (error) {
    logger.error("[Kafka] Error ensuring topic exists", error);
    throw error;
  }
}
