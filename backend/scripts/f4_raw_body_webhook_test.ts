/**
 * F4 raw-body HMAC regression tests.
 * Proves verification uses original request bytes, not JSON.stringify(req.body).
 */
import crypto from "crypto";

const API = process.env.F4_API_BASE || "http://127.0.0.1:3001";
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

function sign(rawBody: string | Buffer): string {
  return crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

async function postRaw(
  body: Buffer,
  signature: string
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
    body,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function dbCount(sql: string): Promise<string> {
  const { execSync } = await import("child_process");
  // Prefer querying via fetch to wallet/events APIs when possible; for F4 we use docker from host.
  return sql;
}

async function main() {
  if (!SECRET) {
    console.error("RAZORPAY_WEBHOOK_SECRET missing");
    process.exit(1);
  }

  const ts = Date.now();
  const userId = `user_f4n_${ts}`;

  // Ensure wallet
  await fetch(`${API}/api/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  }).catch(() => undefined);

  const report: Record<string, any> = { ts, userId };

  // ---- TEST A/D: formatted raw JSON (whitespace differs from JSON.stringify) ----
  const payA = `pay_f4n_raw_${ts}`;
  const evtA = `evt_rzp_f4n_raw_${ts}`;
  const rawAStr = `{
  "event": "payment.captured",
  "entity": "event",
  "event_id": "${evtA}",
  "item": {
    "id": "${payA}"
  },
  "payload": {
    "payment": {
      "entity": {
        "id": "${payA}",
        "order_id": "order_f4n_${ts}",
        "amount": 6100,
        "currency": "INR",
        "status": "captured",
        "notes": {
          "userId": "${userId}"
        }
      }
    }
  }
}`;
  const rawA = Buffer.from(rawAStr, "utf8");
  const parsed = JSON.parse(rawAStr);
  const reserialized = Buffer.from(JSON.stringify(parsed), "utf8");
  const differs = !rawA.equals(reserialized);
  console.log(`RAW_DIFFERS_FROM_JSON_STRINGIFY=${differs}`);
  console.log(`RAW_LEN=${rawA.length} RESERIALIZED_LEN=${reserialized.length}`);

  const sigA = sign(rawA);
  const sigWouldFailIfReserialized = sign(reserialized);
  console.log(
    `SIGS_DIFFER=${sigA !== sigWouldFailIfReserialized} (proves formatted body needs raw HMAC)`
  );

  const a = await postRaw(rawA, sigA);
  report.testA = {
    status: a.status,
    message: a.json?.message || a.json?.error,
    pass: a.status === 200 && a.json?.success === true,
  };
  console.log("TEST_A", JSON.stringify(report.testA));

  // Negative control: same formatted body but signature of JSON.stringify(parsed)
  // — would succeed on OLD code, must FAIL on NEW code
  const aNeg = await postRaw(rawA, sigWouldFailIfReserialized);
  report.testA_negative_control = {
    status: aNeg.status,
    pass: aNeg.status === 401,
    note: "signature over JSON.stringify(parsed) must NOT accept formatted raw body",
  };
  console.log("TEST_A_NEG", JSON.stringify(report.testA_negative_control));

  // ---- TEST B: invalid signature ----
  const payB = `pay_f4n_bad_${ts}`;
  const evtB = `evt_rzp_f4n_bad_${ts}`;
  const rawB = Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      entity: "event",
      event_id: evtB,
      item: { id: payB },
      payload: {
        payment: {
          entity: {
            id: payB,
            order_id: "order_bad",
            amount: 6200,
            currency: "INR",
            notes: { userId },
          },
        },
      },
    }),
    "utf8"
  );
  const b = await postRaw(rawB, "00".repeat(32));
  report.testB = {
    status: b.status,
    pass: b.status === 401,
  };
  console.log("TEST_B", JSON.stringify(report.testB));

  // ---- TEST C: sign bodyA, send bodyC ----
  const payC = `pay_f4n_mod_${ts}`;
  const evtC = `evt_rzp_f4n_mod_${ts}`;
  const bodySign = Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      entity: "event",
      event_id: evtC,
      item: { id: payC },
      payload: {
        payment: {
          entity: {
            id: payC,
            order_id: "order_a",
            amount: 6300,
            currency: "INR",
            notes: { userId },
          },
        },
      },
    }),
    "utf8"
  );
  const bodySend = Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      entity: "event",
      event_id: evtC,
      item: { id: payC },
      payload: {
        payment: {
          entity: {
            id: payC,
            order_id: "order_b",
            amount: 9999,
            currency: "INR",
            notes: { userId },
          },
        },
      },
    }),
    "utf8"
  );
  const c = await postRaw(bodySend, sign(bodySign));
  report.testC = {
    status: c.status,
    pass: c.status === 401,
  };
  console.log("TEST_C", JSON.stringify(report.testC));

  // ---- Duplicate of A ----
  const dup = await postRaw(rawA, sigA);
  report.dup = {
    status: dup.status,
    message: dup.json?.message,
    pass:
      dup.status === 200 &&
      (dup.json?.message === "Webhook already processed" ||
        dup.json?.success === true),
  };
  console.log("TEST_DUP", JSON.stringify(report.dup));

  // Wait for wallet pipeline
  await new Promise((r) => setTimeout(r, 6000));

  // Health + F3 path smoke
  const health = await fetch(`${API}/health`).then((r) => r.json());
  report.health = health;

  console.log("==== F4 SUMMARY ====");
  console.log(JSON.stringify(report, null, 2));

  const pass =
    report.testA.pass &&
    report.testA_negative_control.pass &&
    report.testB.pass &&
    report.testC.pass &&
    report.dup.pass;

  console.log(`F4_ALL_PASS=${pass}`);
  console.log(`PAY_A=${payA}`);
  console.log(`EVT_A=${evtA}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
