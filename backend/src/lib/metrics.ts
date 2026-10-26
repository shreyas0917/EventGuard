import client from "prom-client";

/**
 * Prometheus metrics. Each process (API, consumer) has its own registry and endpoint;
 * the `service` label tells them apart, and Prometheus sums counters across both
 * (the API process also runs events, through the retry worker).
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: process.env.SERVICE_NAME || "eventguard-api" });
client.collectDefaultMetrics({ register: registry, prefix: "eventguard_process_" });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const END_TO_END_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300];

// ---------- HTTP ----------

export const httpRequestDuration = new client.Histogram({
  name: "eventguard_http_request_duration_seconds",
  help: "HTTP request latency by route pattern",
  labelNames: ["method", "route", "status"] as const,
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

// ---------- Event processing ----------

export const eventsProcessed = new client.Counter({
  name: "eventguard_events_processed_total",
  help: "Claimed events by outcome: completed, failed (retry or DLQ), lease_lost",
  labelNames: ["event_type", "outcome"] as const,
  registers: [registry],
});

export const eventProcessingDuration = new client.Histogram({
  name: "eventguard_event_processing_duration_seconds",
  help: "Time from claim to commit (or recorded failure) for one attempt",
  labelNames: ["event_type", "outcome"] as const,
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const eventEndToEndLatency = new client.Histogram({
  name: "eventguard_event_end_to_end_seconds",
  help: "Event creation (API commit) to COMPLETED commit, including outbox and Kafka",
  labelNames: ["event_type"] as const,
  buckets: END_TO_END_BUCKETS,
  registers: [registry],
});

export const duplicateDeliveries = new client.Counter({
  name: "eventguard_duplicate_deliveries_total",
  help: "Deliveries that caused no effect, by the guard that stopped them",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const retriesScheduled = new client.Counter({
  name: "eventguard_retries_scheduled_total",
  help: "Failed attempts scheduled for retry with backoff",
  registers: [registry],
});

export const eventsDeadLettered = new client.Counter({
  name: "eventguard_events_dead_lettered_total",
  help: "Events that exhausted their attempts and were moved to the DLQ",
  registers: [registry],
});

export const redisLockErrors = new client.Counter({
  name: "eventguard_redis_lock_errors_total",
  help: "Redis infrastructure errors during lock acquisition (offset left uncommitted)",
  registers: [registry],
});

// ---------- Money ----------

export const walletCredits = new client.Counter({
  name: "eventguard_wallet_credits_total",
  help: "Ledger credits written",
  registers: [registry],
});

export const walletCreditAmount = new client.Counter({
  name: "eventguard_wallet_credit_amount_inr_total",
  help: "Sum of credited amounts in INR",
  registers: [registry],
});

// ---------- Ingress ----------

export const paymentVerifications = new client.Counter({
  name: "eventguard_payment_verifications_total",
  help: "Checkout verifications by result",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const webhooksReceived = new client.Counter({
  name: "eventguard_webhooks_received_total",
  help: "Razorpay webhook deliveries by result",
  labelNames: ["result"] as const,
  registers: [registry],
});

// ---------- Outbox ----------

export const outboxPublished = new client.Counter({
  name: "eventguard_outbox_published_total",
  help: "Outbox rows published to Kafka",
  registers: [registry],
});

export const outboxPublishFailures = new client.Counter({
  name: "eventguard_outbox_publish_failures_total",
  help: "Outbox rows whose publish failed (kept PENDING with backoff)",
  registers: [registry],
});

/**
 * Gauges read from the database / Kafka at scrape time. Registered only by the API
 * process (see registerStateGauges) so two processes never report the same state.
 */
export interface StateProbes {
  outbox: () => Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
  deadLetterOpen: () => Promise<number>;
  eventsByStatus: () => Promise<Record<string, number>>;
  consumerLag: () => Promise<number | null>;
  reconciliationDiscrepancies: () => Record<string, number> | null;
}

export function registerStateGauges(probes: StateProbes): void {
  new client.Gauge({
    name: "eventguard_outbox_backlog",
    help: "Outbox rows waiting to be published",
    registers: [registry],
    async collect() {
      this.set((await probes.outbox()).pending);
    },
  });
  new client.Gauge({
    name: "eventguard_outbox_oldest_pending_age_seconds",
    help: "Age of the oldest unpublished outbox row",
    registers: [registry],
    async collect() {
      this.set((await probes.outbox()).oldestPendingAgeSeconds);
    },
  });
  new client.Gauge({
    name: "eventguard_dlq_open",
    help: "Dead-letter entries not yet resolved",
    registers: [registry],
    async collect() {
      this.set(await probes.deadLetterOpen());
    },
  });
  new client.Gauge({
    name: "eventguard_events",
    help: "Events by status",
    labelNames: ["status"] as const,
    registers: [registry],
    async collect() {
      this.reset();
      for (const [status, count] of Object.entries(await probes.eventsByStatus())) {
        this.set({ status }, count);
      }
    },
  });
  new client.Gauge({
    name: "eventguard_consumer_lag",
    help: "Messages in the topic not yet committed by the consumer group (sum over partitions)",
    registers: [registry],
    async collect() {
      const lag = await probes.consumerLag();
      if (lag !== null) this.set(lag);
    },
  });
  new client.Gauge({
    name: "eventguard_reconciliation_discrepancies",
    help: "Findings from the last reconciliation run, by check",
    labelNames: ["check"] as const,
    registers: [registry],
    collect() {
      const findings = probes.reconciliationDiscrepancies();
      if (!findings) return;
      for (const [check, count] of Object.entries(findings)) {
        this.set({ check }, count);
      }
    },
  });
}
