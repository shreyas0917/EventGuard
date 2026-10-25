/**
 * F3 payment idempotency validation — controlled tests via ensurePaymentSuccessEvent
 * plus optional webhook HTTP when signature can be computed.
 * Run inside backend container: npx tsx scripts/f3_payment_idempotency_test.ts
 */
import crypto from "crypto";
import { prisma } from "../src/lib/prisma.js";
import {
  ensurePaymentSuccessEvent,
  canonicalPaymentEventId,
} from "../src/services/paymentService.js";
import { createWebhookRecord } from "../src/services/webhookService.js";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const API = process.env.F3_API_BASE || "http://localhost:3001";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForWalletTx(eventId: string, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await prisma.walletTransaction.count({ where: { eventId } });
    if (count >= 1) {
      const tx = await prisma.walletTransaction.findUnique({ where: { eventId } });
      const ev = await prisma.event.findUnique({ where: { eventId } });
      return { count, tx, ev };
    }
    await sleep(1500);
  }
  const count = await prisma.walletTransaction.count({ where: { eventId } });
  const tx = await prisma.walletTransaction.findUnique({ where: { eventId } });
  const ev = await prisma.event.findUnique({ where: { eventId } });
  return { count, tx, ev };
}

async function counts(razorpayPaymentId: string) {
  const eventId = canonicalPaymentEventId(razorpayPaymentId);
  const [payments, events, wtxs, payment, event, wtx] = await Promise.all([
    prisma.payment.count({ where: { razorpayPaymentId } }),
    prisma.event.count({ where: { eventId } }),
    prisma.walletTransaction.count({ where: { eventId } }),
    prisma.payment.findUnique({ where: { razorpayPaymentId } }),
    prisma.event.findUnique({ where: { eventId } }),
    prisma.walletTransaction.findUnique({ where: { eventId } }),
  ]);
  return {
    eventId,
    payments,
    events,
    wtxs,
    paymentStatus: payment?.status ?? null,
    eventStatus: event?.status ?? null,
    wtxStatus: wtx?.status ?? null,
  };
}

async function ensureWallet(userId: string) {
  const existing = await prisma.wallet.findUnique({ where: { userId } });
  if (!existing) {
    await prisma.wallet.create({
      data: { userId, balance: 0 },
    });
  }
}

function signBody(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
}

async function postWebhook(payload: object): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(payload);
  const signature = signBody(raw);
  const res = await fetch(`${API}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
    body: raw,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

function buildCapturedPayload(
  razorpayEventId: string,
  razorpayPaymentId: string,
  userId: string,
  amountPaise: number,
  orderId: string
) {
  return {
    event: "payment.captured",
    entity: "event",
    event_id: razorpayEventId,
    item: { id: razorpayPaymentId },
    payload: {
      payment: {
        entity: {
          id: razorpayPaymentId,
          order_id: orderId,
          amount: amountPaise,
          currency: "INR",
          status: "captured",
          notes: { userId },
        },
      },
    },
  };
}

async function main() {
  const ts = Date.now();
  const report: Record<string, any> = { ts };

  console.log("==== F3 PAYMENT IDEMPOTENCY TESTS ====");
  console.log(`WEBHOOK_SECRET_SET=${!!WEBHOOK_SECRET}`);

  // ---------- TEST 1: VERIFY PATH ----------
  {
    const payId = `pay_f3_t1_${ts}`;
    const userId = `user_f3_t1_${ts}`;
    const amount = 41;
    await ensureWallet(userId);

    const r1 = await ensurePaymentSuccessEvent({
      razorpayPaymentId: payId,
      razorpayOrderId: `order_f3_t1_${ts}`,
      userId,
      amount,
      source: "verify",
    });
    console.log("T1 ensure:", r1.eventId, "created=", r1.eventCreated);

    const waited = await waitForWalletTx(r1.eventId);
    const c = await counts(payId);
    report.test1 = {
      ...c,
      eventCreated: r1.eventCreated,
      waitedTx: waited.count,
      pass:
        c.payments === 1 &&
        c.events === 1 &&
        c.wtxs === 1 &&
        c.paymentStatus === "PAID" &&
        c.eventId === `evt_${payId}`,
    };
    console.log("TEST1", JSON.stringify(report.test1));
  }

  // ---------- TEST 2: REPEATED VERIFY ----------
  {
    const payId = `pay_f3_t2_${ts}`;
    const userId = `user_f3_t2_${ts}`;
    const amount = 42;
    await ensureWallet(userId);

    const r1 = await ensurePaymentSuccessEvent({
      razorpayPaymentId: payId,
      razorpayOrderId: `order_f3_t2_${ts}`,
      userId,
      amount,
      source: "verify",
    });
    await waitForWalletTx(r1.eventId);

    const r2 = await ensurePaymentSuccessEvent({
      razorpayPaymentId: payId,
      razorpayOrderId: `order_f3_t2_${ts}`,
      userId,
      amount,
      source: "verify",
    });
    await sleep(3000);
    const c = await counts(payId);
    report.test2 = {
      ...c,
      firstCreated: r1.eventCreated,
      secondCreated: r2.eventCreated,
      sameEventId: r1.eventId === r2.eventId,
      pass:
        c.payments === 1 &&
        c.events === 1 &&
        c.wtxs === 1 &&
        !r2.eventCreated &&
        r1.eventId === r2.eventId,
    };
    console.log("TEST2", JSON.stringify(report.test2));
  }

  // ---------- TEST 3: WEBHOOK AFTER VERIFY ----------
  {
    const payId = `pay_f3_t3_${ts}`;
    const userId = `user_f3_t3_${ts}`;
    const amount = 43;
    await ensureWallet(userId);

    const r1 = await ensurePaymentSuccessEvent({
      razorpayPaymentId: payId,
      razorpayOrderId: `order_f3_t3_${ts}`,
      userId,
      amount,
      source: "verify",
    });
    await waitForWalletTx(r1.eventId);

    // Simulate webhook path via same ensure helper (source=webhook)
    const r2 = await ensurePaymentSuccessEvent({
      razorpayPaymentId: payId,
      razorpayOrderId: `order_f3_t3_${ts}`,
      userId,
      amount,
      source: "webhook",
    });

    // Also exercise webhook HTTP if secret works
    let httpStatus: number | null = null;
    let httpOk = false;
    if (WEBHOOK_SECRET) {
      const payload = buildCapturedPayload(
        `evt_rzp_f3_t3_${ts}`,
        payId,
        userId,
        amount * 100,
        `order_f3_t3_${ts}`
      );
      try {
        const hw = await postWebhook(payload);
        httpStatus = hw.status;
        httpOk = hw.status === 200;
      } catch (e) {
        httpStatus = -1;
      }
    }

    await sleep(2000);
    const c = await counts(payId);
    report.test3 = {
      ...c,
      verifyCreated: r1.eventCreated,
      webhookEnsureCreated: r2.eventCreated,
      httpStatus,
      httpOk,
      pass:
        c.payments === 1 &&
        c.events === 1 &&
        c.wtxs === 1 &&
        !r2.eventCreated,
    };
    console.log("TEST3", JSON.stringify(report.test3));
  }

  // ---------- TEST 4: WEBHOOK BEFORE VERIFY ----------
  {
    const payId = `pay_f3_t4_${ts}`;
    const userId = `user_f3_t4_${ts}`;
    const amount = 44;
    await ensureWallet(userId);

    let webhookHttp: any = { status: null, verified: false };
    if (WEBHOOK_SECRET) {
      const payload = buildCapturedPayload(
        `evt_rzp_f3_t4_${ts}`,
        payId,
        userId,
        amount * 100,
        `order_f3_t4_${ts}`
      );
      try {
        const hw = await postWebhook(payload);
        webhookHttp = { status: hw.status, body: hw.body };
      } catch (e: any) {
        webhookHttp = { status: -1, error: String(e) };
      }
    } else {
      // Controlled: webhook path first via ensure
      await ensurePaymentSuccessEvent({
        razorpayPaymentId: payId,
        razorpayOrderId: `order_f3_t4_${ts}`,
        userId,
        amount,
        source: "webhook",
      });
    }

    // If HTTP webhook failed (F4), fall back to ensure(source=webhook) then verify
    let afterWebhook = await counts(payId);
    if (afterWebhook.payments === 0) {
      await ensurePaymentSuccessEvent({
        razorpayPaymentId: payId,
        razorpayOrderId: `order_f3_t4_${ts}`,
        userId,
        amount,
        source: "webhook",
      });
      afterWebhook = await counts(payId);
      webhookHttp.fallbackEnsure = true;
    }

    await waitForWalletTx(afterWebhook.eventId);

    const rVerify = await ensurePaymentSuccessEvent({
      razorpayPaymentId: payId,
      razorpayOrderId: `order_f3_t4_${ts}`,
      userId,
      amount,
      source: "verify",
    });
    await sleep(2000);
    const c = await counts(payId);
    report.test4 = {
      ...c,
      webhookHttp,
      verifyCreated: rVerify.eventCreated,
      pass:
        c.payments === 1 &&
        c.events === 1 &&
        c.wtxs === 1 &&
        !rVerify.eventCreated,
      note:
        webhookHttp.fallbackEnsure || webhookHttp.status !== 200
          ? "HTTP webhook may be F4-blocked; used ensure(source=webhook) for ordering"
          : "HTTP webhook used",
    };
    console.log("TEST4", JSON.stringify(report.test4));
  }

  // ---------- TEST 5: DUPLICATE WEBHOOK ----------
  {
    const payId = `pay_f3_t5_${ts}`;
    const userId = `user_f3_t5_${ts}`;
    const amount = 45;
    const rzpEventId = `evt_rzp_f3_t5_${ts}`;
    await ensureWallet(userId);

    let mode = "ensure";
    if (WEBHOOK_SECRET) {
      const payload = buildCapturedPayload(
        rzpEventId,
        payId,
        userId,
        amount * 100,
        `order_f3_t5_${ts}`
      );
      const h1 = await postWebhook(payload);
      const h2 = await postWebhook(payload);
      if (h1.status === 200 || h1.status === 401) {
        mode = "http";
        await sleep(3000);
        // If first HTTP failed signature, use ensure + duplicate webhook record uniqueness
        if (h1.status !== 200) {
          mode = "ensure+webhookRecord";
          await ensurePaymentSuccessEvent({
            razorpayPaymentId: payId,
            razorpayOrderId: `order_f3_t5_${ts}`,
            userId,
            amount,
            source: "webhook",
          });
          try {
            await createWebhookRecord(rzpEventId, "payment.captured", payId, payload);
          } catch {}
          try {
            await createWebhookRecord(rzpEventId, "payment.captured", payId, payload);
          } catch {}
        }
        report.test5_http = { h1: h1.status, h2: h2.status, h2body: h2.body };
      }
    }

    if (mode !== "http") {
      await ensurePaymentSuccessEvent({
        razorpayPaymentId: payId,
        razorpayOrderId: `order_f3_t5_${ts}`,
        userId,
        amount,
        source: "webhook",
      });
      await ensurePaymentSuccessEvent({
        razorpayPaymentId: payId,
        razorpayOrderId: `order_f3_t5_${ts}`,
        userId,
        amount,
        source: "webhook",
      });
      // Duplicate webhook event_id uniqueness
      const payload = { event: "payment.captured", event_id: rzpEventId };
      const w1 = await createWebhookRecord(rzpEventId, "payment.captured", payId, payload);
      let w2Dup = false;
      try {
        await createWebhookRecord(rzpEventId, "payment.captured", payId, payload);
      } catch {
        w2Dup = true;
      }
      // createWebhookRecord returns null/throws on P2002 - check
      const whCount = await prisma.webhookEvent.count({
        where: { razorpayEventId: rzpEventId },
      });
      report.test5_webhookRecords = { w1Id: w1?.id, whCount, w2Dup };
    }

    await waitForWalletTx(canonicalPaymentEventId(payId));
    await sleep(2000);
    const c = await counts(payId);
    const whCount = await prisma.webhookEvent.count({
      where: { razorpayEventId: rzpEventId },
    });
    report.test5 = {
      ...c,
      mode,
      webhookRows: whCount,
      pass: c.payments === 1 && c.events === 1 && c.wtxs === 1,
    };
    console.log("TEST5", JSON.stringify(report.test5));
  }

  // ---------- TEST 6: CONCURRENT VERIFY + WEBHOOK ----------
  {
    const payId = `pay_f3_t6_${ts}`;
    const userId = `user_f3_t6_${ts}`;
    const amount = 46;
    await ensureWallet(userId);

    const [a, b] = await Promise.all([
      ensurePaymentSuccessEvent({
        razorpayPaymentId: payId,
        razorpayOrderId: `order_f3_t6_${ts}`,
        userId,
        amount,
        source: "verify",
      }),
      ensurePaymentSuccessEvent({
        razorpayPaymentId: payId,
        razorpayOrderId: `order_f3_t6_${ts}`,
        userId,
        amount,
        source: "webhook",
      }),
    ]);

    await waitForWalletTx(canonicalPaymentEventId(payId));
    await sleep(2000);
    const c = await counts(payId);
    const createdCount = [a, b].filter((x) => x.eventCreated).length;
    report.test6 = {
      ...c,
      aCreated: a.eventCreated,
      bCreated: b.eventCreated,
      createdCount,
      sameEventId: a.eventId === b.eventId,
      pass:
        c.payments === 1 &&
        c.events === 1 &&
        c.wtxs === 1 &&
        a.eventId === b.eventId &&
        createdCount <= 1,
    };
    console.log("TEST6", JSON.stringify(report.test6));
  }

  console.log("==== F3 SUMMARY ====");
  console.log(JSON.stringify(report, null, 2));

  const allPass = ["test1", "test2", "test3", "test4", "test5", "test6"].every(
    (k) => report[k]?.pass === true
  );
  console.log(`F3_ALL_PASS=${allPass}`);

  await prisma.$disconnect();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
