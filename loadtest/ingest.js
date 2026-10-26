/**
 * EventGuard ingest load test (k6).
 *
 * Scenario "ingest": a constant arrival rate of PAYMENT_SUCCESS events, each with a
 * unique eventId, spread over a pool of wallets. A share of iterations immediately
 * re-sends the same eventId (a client retry) and must get 409.
 *
 * Scenario "storm": many VUs send one shared eventId at the same moment, so exactly
 * one request may create it (201) and every other one must be refused (409).
 *
 * End-to-end processing (outbox → Kafka → credit) is measured afterwards from the
 * database by backend/scripts/loadtest-report.ts, because k6 only sees the HTTP side.
 *
 * Run through scripts/perf/run-loadtest.sh, which prepares an isolated environment.
 */
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3101";
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || "60s";
const WALLETS = Number(__ENV.WALLETS || 50);
const DUPLICATE_SHARE = Number(__ENV.DUPLICATE_SHARE || 0.1);
const STORM_VUS = Number(__ENV.STORM_VUS || 100);

// 409 is the correct answer to a duplicate, not an error; creates are checked for 201 separately
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

const created = new Counter("events_created");
const duplicateRejected = new Counter("duplicates_rejected");
const duplicateAccepted = new Counter("duplicates_accepted"); // must stay 0
const stormCreated = new Counter("storm_created"); // must be exactly 1

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      exec: "ingest",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.max(20, RATE),
      maxVUs: Math.max(200, RATE * 4),
    },
    storm: {
      executor: "per-vu-iterations",
      exec: "storm",
      vus: STORM_VUS,
      iterations: 1,
      startTime: "5s",
    },
  },
  thresholds: {
    "http_req_failed{scenario:ingest}": ["rate<0.01"],
    "checks{scenario:ingest}": ["rate>0.99"],
    duplicates_accepted: ["count==0"],
    storm_created: ["count==1"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function json(body, token) {
  return {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    tags: {},
  };
}

export function setup() {
  const login = http.post(
    `${BASE_URL}/api/auth/demo-login`,
    JSON.stringify({ userId: "loadtest-admin", role: "admin", adminKey: __ENV.ADMIN_KEY }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(login, { "admin login": (r) => r.status === 200 });
  const token = login.json("token");

  for (let i = 0; i < WALLETS; i++) {
    http.post(`${BASE_URL}/api/wallets`, JSON.stringify({ userId: `lt_${RUN_ID}_user_${i}` }), json(null, token));
  }
  return { token };
}

function paymentEvent(eventId, userIndex) {
  return JSON.stringify({
    eventId,
    eventType: "PAYMENT_SUCCESS",
    payload: {
      userId: `lt_${RUN_ID}_user_${userIndex}`,
      paymentId: `pay_${eventId}`,
      orderId: `order_${eventId}`,
      amount: 1.25,
    },
  });
}

export function ingest(data) {
  const eventId = `lt_${RUN_ID}_${__VU}_${__ITER}`;
  const body = paymentEvent(eventId, Math.floor(Math.random() * WALLETS));
  const params = { ...json(null, data.token), tags: { kind: "create" } };

  const res = http.post(`${BASE_URL}/api/events`, body, params);
  if (check(res, { "created (201)": (r) => r.status === 201 })) created.add(1);

  if (Math.random() < DUPLICATE_SHARE) {
    const retry = http.post(`${BASE_URL}/api/events`, body, { ...params, tags: { kind: "duplicate" } });
    if (retry.status === 409) duplicateRejected.add(1);
    else duplicateAccepted.add(1);
  }
}

export function storm(data) {
  const res = http.post(`${BASE_URL}/api/events`, paymentEvent(`lt_${RUN_ID}_storm`, 0), {
    ...json(null, data.token),
    tags: { kind: "storm" },
  });
  if (res.status === 201) stormCreated.add(1);
  else check(res, { "storm duplicate refused (409)": (r) => r.status === 409 });
}
