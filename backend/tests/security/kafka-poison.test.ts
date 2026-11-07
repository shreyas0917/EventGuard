import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KafkaMessage } from "kafkajs";

// Mock the worker so handleMessage never touches Redis/PostgreSQL; we assert whether it is called.
const processEvent = vi.fn(async () => {});
vi.mock("../../src/kafka/eventWorker.js", () => ({ processEvent }));

const { handleMessage } = await import("../../src/kafka/consumer.js");
const { kafkaInvalidMessages } = await import("../../src/lib/metrics.js");

function msg(key: string | null, value: string | null) {
  return {
    partition: 0,
    message: {
      key: key === null ? null : Buffer.from(key),
      value: value === null ? null : Buffer.from(value),
      offset: "0",
    } as unknown as KafkaMessage,
  };
}

async function invalidCount(reason: string): Promise<number> {
  const data = await kafkaInvalidMessages.get();
  return data.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

const validBody = JSON.stringify({ eventId: "evt_ok", eventType: "PAYMENT_SUCCESS", payload: {} });

beforeEach(() => processEvent.mockClear());

describe("handleMessage poison handling", () => {
  it.each([
    ["missing key or value", msg(null, validBody), "missing_key_or_value"],
    ["invalid JSON", msg("evt_bad", "{not json"), "invalid_json"],
    ["missing eventId/eventType", msg("evt_bad", JSON.stringify({ hello: "world" })), "missing_fields"],
  ])("drops a %s message without throwing, counts it, and does not process", async (_name, payload, reason) => {
    const before = await invalidCount(reason);

    await expect(handleMessage(payload)).resolves.toBeUndefined();

    expect(await invalidCount(reason)).toBe(before + 1);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("processes a valid message", async () => {
    await handleMessage(msg("evt_ok", validBody));
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt_ok", eventType: "PAYMENT_SUCCESS" }));
  });

  it("rethrows a transient processing error so the offset is not committed", async () => {
    processEvent.mockRejectedValueOnce(new Error("redis down"));
    await expect(handleMessage(msg("evt_ok", validBody))).rejects.toThrow("redis down");
  });
});
