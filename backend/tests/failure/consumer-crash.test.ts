import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Producer } from "kafkajs";

/**
 * Real process crashes. The consumer runs as its own OS process (src/eventConsumer.ts)
 * and FAULT_INJECTION kills it with exit code 137 at a chosen point; a fresh process
 * in the same consumer group then receives the uncommitted message again.
 */
const TOPIC = `eventguard.failure.crash.${Date.now()}`;
const LEASE_SECONDS = "3";
Object.assign(process.env, { KAFKA_TOPIC: TOPIC, EVENT_LEASE_SECONDS: LEASE_SECONDS });

const { connectRedis, closeRedis } = await import("../../src/lib/redis.js");
const { connectKafka, getKafka } = await import("../../src/lib/kafka.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { runRetryCycle } = await import("../../src/workers/retryWorker.js");
const db = await import("../helpers/db.js");
const { spawnConsumer, waitFor, sleep } = await import("../helpers/infra.js");
type ConsumerProcess = import("../helpers/infra.js").ConsumerProcess;

let producer: Producer;
const running: ConsumerProcess[] = [];

function consumer(group: string, fault?: string): ConsumerProcess {
  const proc = spawnConsumer({
    KAFKA_TOPIC: TOPIC,
    KAFKA_CONSUMER_GROUP: group,
    KAFKA_SESSION_TIMEOUT_MS: "10000",
    EVENT_LEASE_SECONDS: LEASE_SECONDS,
    // The crashed process's Redis lock outlives it until this TTL
    REDIS_LOCK_TTL_SECONDS: LEASE_SECONDS,
    ...(fault ? { FAULT_INJECTION: fault } : {}),
  });
  running.push(proc);
  return proc;
}

async function exitCode(proc: ConsumerProcess, timeoutMs: number): Promise<number | null> {
  const timeout = sleep(timeoutMs).then(() => {
    throw new Error(`consumer did not exit within ${timeoutMs} ms. Output:\n${proc.output()}`);
  });
  return Promise.race([proc.exited, timeout]);
}

const duplicates = (eventId: string) => prisma.eventLog.count({ where: { eventId, status: "DUPLICATE" } });

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
  expect(await connectKafka()).toBe(true);
  const admin = getKafka().admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
  await admin.disconnect();
  producer = getKafka().producer();
  await producer.connect();
});

afterAll(async () => {
  for (const proc of running) {
    if (proc.child.exitCode === null) proc.child.kill();
  }
  await producer?.disconnect();
  const admin = getKafka().admin();
  await admin.connect();
  await admin.deleteTopics({ topics: [TOPIC] }).catch(() => {});
  await admin.disconnect();
  await closeRedis();
  await prisma.$disconnect();
});

beforeEach(() => db.resetState());

describe("consumer process crashes", () => {
  it("crash after the credit commits but before the Kafka offset commit: the redelivery is a no-op", async () => {
    await db.seedWallet("user_crash_after");
    const message = await db.seedPaymentEvent("evt_crash_after", "user_crash_after", 150);
    await producer.send({ topic: TOPIC, messages: [{ key: message.eventId, value: JSON.stringify(message) }] });
    const group = `crash-after-${Date.now()}`;

    const first = consumer(group, `crash-after-commit:${message.eventId}`);
    expect(await exitCode(first, 90_000)).toBe(137);

    // The credit and COMPLETED committed together just before the process died
    expect((await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } })).status).toBe("COMPLETED");
    expect(await prisma.walletTransaction.count()).toBe(1);

    // The offset was never committed, so Kafka hands the message to the next process
    const second = consumer(group);
    await waitFor(async () => (await duplicates(message.eventId)) >= 1, 120_000, "redelivery to the restarted consumer");

    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(await db.walletBalance("user_crash_after")).toBe("150.00");
    expect(await db.ledgerViolations()).toEqual([]);
    second.child.kill();
  });

  it("crash after claiming but before committing: the lease expires and recovery credits exactly once", async () => {
    await db.seedWallet("user_crash_before");
    const message = await db.seedPaymentEvent("evt_crash_before", "user_crash_before", 80);
    await producer.send({ topic: TOPIC, messages: [{ key: message.eventId, value: JSON.stringify(message) }] });
    const group = `crash-before-${Date.now()}`;

    const first = consumer(group, `crash-before-commit:${message.eventId}`);
    expect(await exitCode(first, 90_000)).toBe(137);

    // Claimed, nothing paid: the transaction that would have credited never ran
    const stranded = await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } });
    expect(stranded.status).toBe("PROCESSING");
    expect(await prisma.walletTransaction.count()).toBe(0);

    // The API's retry worker finds the expired lease and finishes the event. Passes that
    // run while the dead process's Redis lock is still alive back off as contention;
    // the worker simply tries again on its next pass, as it does every 2 s in production.
    await waitFor(
      async () => {
        await runRetryCycle();
        return (await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } })).status === "COMPLETED";
      },
      60_000,
      "recovery sweep completes the stranded event"
    );
    const recovered = await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } });
    expect(recovered.attemptCount).toBe(2);

    // The Kafka redelivery that follows the restart is absorbed as a duplicate
    const second = consumer(group);
    await waitFor(async () => (await duplicates(message.eventId)) >= 1, 120_000, "redelivery to the restarted consumer");

    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(await db.walletBalance("user_crash_before")).toBe("80.00");
    expect(await db.ledgerViolations()).toEqual([]);
    second.child.kill();
  });
});
