import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Consumer } from "kafkajs";
import { TEST_DATABASE_URL } from "../setup/integration-config.js";

/**
 * Dependencies failing underneath the pipeline, using the disposable test stack:
 * "stop" refuses connections (a crashed service), "pause" leaves them open but
 * unanswered (a hung service or a network partition). In every case the invariant
 * is the same: no money moves while it is down, exactly one credit once it is back.
 *
 * A timeout is an ambiguous outcome: the command may still run when the service
 * wakes up (a claim or a Redis lock nobody owns). The tests do not assume either
 * way; they check that the redelivery or the recovery sweep finishes the job.
 */
const TOPIC = `eventguard.failure.outage.${Date.now()}`;
Object.assign(process.env, {
  KAFKA_TOPIC: TOPIC,
  // A hung PostgreSQL must fail queries rather than block forever
  DATABASE_URL: `${TEST_DATABASE_URL}&socket_timeout=5`,
  // Short-lived leases, locks and stale threshold so recovery happens within the test
  EVENT_LEASE_SECONDS: "3",
  REDIS_LOCK_TTL_SECONDS: "3",
  STALE_RECEIVED_SECONDS: "2",
});

const { connectRedis, closeRedis, getRedis } = await import("../../src/lib/redis.js");
const { connectKafka, getKafka } = await import("../../src/lib/kafka.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { initializeProducer, disconnectProducer } = await import("../../src/kafka/producer.js");
const { createEventConsumer, runEventConsumer } = await import("../../src/kafka/consumer.js");
const { processOutboxBatch } = await import("../../src/services/outboxPublisher.js");
const { processEvent } = await import("../../src/kafka/eventWorker.js");
const { runRetryCycle } = await import("../../src/workers/retryWorker.js");
const db = await import("../helpers/db.js");
const infra = await import("../helpers/infra.js");

const consumers: Consumer[] = [];

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
  expect(await connectKafka()).toBe(true);
  const admin = getKafka().admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
  await admin.disconnect();
  await initializeProducer();
});

afterEach(async () => {
  // Never leave the shared test stack broken for the next test, whatever happened
  for (const service of ["postgres", "redis"] as const) {
    try {
      infra.unpauseService(service);
    } catch {
      // not paused
    }
  }
});

afterAll(async () => {
  await Promise.all(consumers.map((c) => c.disconnect()));
  await disconnectProducer();
  const admin = getKafka().admin();
  await admin.connect();
  await admin.deleteTopics({ topics: [TOPIC] }).catch(() => {});
  await admin.disconnect();
  await closeRedis();
  await prisma.$disconnect();
});

beforeEach(() => db.resetState());

async function expectUntouched(eventId: string) {
  const event = await prisma.event.findUniqueOrThrow({ where: { eventId } });
  expect(event.status).toBe("RECEIVED");
  expect(event.attemptCount).toBe(0);
  expect(await prisma.walletTransaction.count()).toBe(0);
}

/**
 * After an outage: Kafka redelivers the uncommitted message once; if that delivery
 * meets a leftover claim or lock, the API's recovery sweep finishes the event.
 */
async function redeliverAndRecover(message: { eventId: string; eventType: string; payload: any }) {
  await processEvent(message);
  await infra.waitFor(
    async () => {
      const event = await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } });
      if (event.status === "COMPLETED") return true;
      await runRetryCycle();
      return false;
    },
    30_000,
    "recovery after the outage"
  );
}

async function expectCreditedOnce(eventId: string, userId: string, balance: string) {
  expect((await prisma.event.findUniqueOrThrow({ where: { eventId } })).status).toBe("COMPLETED");
  expect(await prisma.walletTransaction.count({ where: { eventId } })).toBe(1);
  expect(await db.walletBalance(userId)).toBe(balance);
  expect(await db.ledgerViolations()).toEqual([]);
}

describe("Redis outages", () => {
  it("Redis stopped: the delivery fails fast with RedisLockError (offset not committed) and succeeds once Redis is back", async () => {
    await db.seedWallet("user_redis_down");
    const message = await db.seedPaymentEvent("evt_redis_down", "user_redis_down", 60);

    infra.stopService("redis");
    try {
      await expect(processEvent(message)).rejects.toMatchObject({ name: "RedisLockError" });
      await expectUntouched(message.eventId);
    } finally {
      await infra.startService("redis");
    }

    await infra.waitFor(async () => getRedis().status === "ready", 30_000, "Redis client reconnect");
    await processEvent(message);
    await expectCreditedOnce(message.eventId, "user_redis_down", "60.00");
  });

  it("Redis hung: commands time out instead of stalling the consumer", async () => {
    await db.seedWallet("user_redis_hung");
    const message = await db.seedPaymentEvent("evt_redis_hung", "user_redis_hung", 45);

    infra.pauseService("redis");
    const started = Date.now();
    try {
      await expect(processEvent(message)).rejects.toMatchObject({ name: "RedisLockError" });
      // Cache lookup and lock attempt each give up after REDIS_COMMAND_TIMEOUT_MS (2 s)
      expect(Date.now() - started).toBeLessThan(15_000);
      await expectUntouched(message.eventId);
    } finally {
      infra.unpauseService("redis");
    }

    // The timed-out SET NX may still land when Redis wakes up, leaving a lock nobody owns
    await redeliverAndRecover(message);
    await expectCreditedOnce(message.eventId, "user_redis_hung", "45.00");
  });
});

describe("PostgreSQL outage", () => {
  it("PostgreSQL hung: the delivery fails without a partial write and succeeds once it answers again", async () => {
    await db.seedWallet("user_pg_hung");
    const message = await db.seedPaymentEvent("evt_pg_hung", "user_pg_hung", 30);

    infra.pauseService("postgres");
    try {
      await expect(processEvent(message)).rejects.toThrow();
    } finally {
      infra.unpauseService("postgres");
    }

    await infra.waitFor(
      async () => (await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false)) as boolean,
      30_000,
      "PostgreSQL reconnect"
    );
    // The claim may or may not have been applied after the client gave up; money never moved
    expect(await prisma.walletTransaction.count()).toBe(0);

    await redeliverAndRecover(message);
    await expectCreditedOnce(message.eventId, "user_pg_hung", "30.00");
  });
});

describe("Kafka outage", () => {
  it("Kafka stopped: the outbox keeps the event PENDING with backoff, then publishes and it is credited once", async () => {
    await db.seedWallet("user_kafka_down");
    const message = await db.seedPaymentEvent("evt_kafka_down", "user_kafka_down", 99);

    infra.stopService("kafka");
    try {
      expect(await processOutboxBatch({ batchSize: 10, enabled: true })).toBe(0);
      const parked = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: message.eventId } });
      expect(parked.status).toBe("PENDING");
      expect(parked.attemptCount).toBe(1);
      expect(parked.lastError).toBeTruthy();
      expect(parked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() - 1000);
    } finally {
      await infra.startService("kafka");
    }

    // Once the backoff lapses and the producer reconnects, the next cycles publish it
    await infra.waitFor(
      async () => (await processOutboxBatch({ batchSize: 10, enabled: true })) === 1,
      90_000,
      "outbox publish after Kafka restart"
    );
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: message.eventId } })).status).toBe(
      "PUBLISHED"
    );

    const consumer = await createEventConsumer({ groupId: `outage-${Date.now()}`, topic: TOPIC, fromBeginning: true });
    consumers.push(consumer);
    await runEventConsumer(consumer);
    await infra.waitFor(
      async () => (await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } })).status === "COMPLETED",
      90_000,
      "consumer completes the event"
    );
    await expectCreditedOnce(message.eventId, "user_kafka_down", "99.00");
    // A broker stop/start plus producer reconnect backoff takes minutes on a loaded machine
  }, 300_000);
});
