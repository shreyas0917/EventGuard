import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Consumer, Producer } from "kafkajs";

// A throwaway topic per run, so the dev stack's consumer never sees these messages
const TOPIC = `eventguard.events.test.${Date.now()}`;
process.env.KAFKA_TOPIC = TOPIC;

const { connectRedis, closeRedis } = await import("../../src/lib/redis.js");
const { connectKafka, getKafka } = await import("../../src/lib/kafka.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { createEventConsumer, runEventConsumer } = await import("../../src/kafka/consumer.js");
const db = await import("../helpers/db.js");

const COPIES = 100;
const consumers: Consumer[] = [];
let producer: Producer;

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
  expect(await connectKafka()).toBe(true);
  const admin = getKafka().admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
  await admin.disconnect();
  producer = getKafka().producer();
  await producer.connect();
  await db.resetState();
});

afterAll(async () => {
  await Promise.all(consumers.map((c) => c.disconnect()));
  await producer?.disconnect();
  const admin = getKafka().admin();
  await admin.connect();
  await admin.deleteTopics({ topics: [TOPIC] }).catch(() => {});
  await admin.disconnect();
  await closeRedis();
  await prisma.$disconnect();
});

describe("competing Kafka consumers", () => {
  it(`${COPIES} copies of one event, consumed by two independent consumer groups, credit once`, async () => {
    await db.seedWallet("user_kafka");
    const message = await db.seedPaymentEvent("evt_kafka_1", "user_kafka", 320.5);

    // Two groups each receive every copy, so 2 × COPIES deliveries race on one event.
    // This models overlapping deployments or a rebalance handing the partition to a new owner.
    for (const groupId of [`fleet-a-${TOPIC}`, `fleet-b-${TOPIC}`]) {
      const consumer = await createEventConsumer({ groupId, topic: TOPIC, fromBeginning: true });
      consumers.push(consumer);
      await runEventConsumer(consumer);
    }

    await producer.send({
      topic: TOPIC,
      messages: Array.from({ length: COPIES }, () => ({ key: message.eventId, value: JSON.stringify(message) })),
    });

    // Every delivery leaves a trace: one PROCESSING claim, or a DUPLICATE record
    await waitFor(async () => {
      const handled = await prisma.eventLog.count({
        where: { eventId: message.eventId, status: { in: ["PROCESSING", "DUPLICATE"] } },
      });
      return handled >= 2 * COPIES;
    }, 90_000);

    expect(await prisma.walletTransaction.count({ where: { eventId: message.eventId } })).toBe(1);
    expect(await db.walletBalance("user_kafka")).toBe("320.50");
    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } });
    expect(event.status).toBe("COMPLETED");
    expect(event.attemptCount).toBe(1);
    expect(await db.ledgerViolations()).toEqual([]);
  });
});
