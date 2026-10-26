import { prisma, TX_OPTIONS } from "../lib/prisma.js";
import { getRazorpay, getRazorpayKeySecret } from "../lib/razorpay.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";

export interface CreateOrderRequest {
  userId: string;
  amount: number; // in paise (1 INR = 100 paise)
  description: string;
}

export interface VerifyPaymentRequest {
  orderId: string;
  paymentId: string;
  signature: string;
  userId: string;
}

export interface EnsurePaymentSuccessInput {
  razorpayPaymentId: string;
  razorpayOrderId: string | null;
  userId: string | null;
  amount: number; // INR
  currency?: string;
  metadata?: Record<string, any> | null;
  source: "verify" | "webhook";
}

export interface EnsurePaymentSuccessResult {
  payment: any;
  eventId: string;
  eventCreated: boolean;
  alreadyPaid: boolean;
}

/** Canonical EventGuard eventId for a Razorpay payment (verify + webhook must agree). */
export function canonicalPaymentEventId(razorpayPaymentId: string): string {
  return `evt_${razorpayPaymentId}`;
}

/**
 * Durable payment-level idempotency:
 * - upsert/create Payment as PAID (never create a second row for same razorpayPaymentId)
 * - create Event + Outbox + EventLog once for evt_${razorpayPaymentId}
 * Safe under concurrent verify + webhook via UNIQUE constraints.
 */
export async function ensurePaymentSuccessEvent(
  input: EnsurePaymentSuccessInput
): Promise<EnsurePaymentSuccessResult> {
  const {
    razorpayPaymentId,
    razorpayOrderId,
    userId,
    amount,
    currency = "INR",
    metadata = null,
    source,
  } = input;

  const eventId = canonicalPaymentEventId(razorpayPaymentId);
  const eventPayload = {
    userId: userId || `user_${razorpayPaymentId}`,
    paymentId: razorpayPaymentId,
    orderId: razorpayOrderId,
    amount,
    currency,
    source,
  };

  return prisma.$transaction(async (tx) => {
    // Serialize verify + webhook for the same Razorpay payment (avoids P2002 aborting the tx).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pay:${razorpayPaymentId}`}))`;

    let payment = await tx.payment.findUnique({
      where: { razorpayPaymentId },
    });

    let alreadyPaid = false;

    if (!payment) {
      payment = await tx.payment.create({
        data: {
          razorpayPaymentId,
          razorpayOrderId,
          userId,
          amount,
          currency,
          status: "PAID",
          metadata: metadata ?? undefined,
        },
      });
    } else if (payment.status === "PAID") {
      alreadyPaid = true;
      // Fill missing userId/orderId if a later path has better data; do not change status.
      const needsEnrichment =
        (userId && !payment.userId) ||
        (razorpayOrderId && !payment.razorpayOrderId);
      if (needsEnrichment) {
        payment = await tx.payment.update({
          where: { razorpayPaymentId },
          data: {
            userId: payment.userId || userId,
            razorpayOrderId: payment.razorpayOrderId || razorpayOrderId,
          },
        });
      }
    } else {
      // Promote PENDING/FAILED → PAID (e.g. failed webhook then successful verify)
      payment = await tx.payment.update({
        where: { razorpayPaymentId },
        data: {
          status: "PAID",
          amount,
          currency,
          userId: userId || payment.userId,
          razorpayOrderId: razorpayOrderId || payment.razorpayOrderId,
          errorMessage: null,
          metadata: metadata ?? payment.metadata ?? undefined,
        },
      });
    }

    const existingEvent = await tx.event.findUnique({
      where: { eventId },
    });

    if (existingEvent) {
      logger.info(
        `[Payment] Idempotent hit for ${razorpayPaymentId}: event ${eventId} already exists (source=${source})`
      );
      return {
        payment,
        eventId,
        eventCreated: false,
        alreadyPaid: true,
      };
    }

    await tx.event.create({
      data: {
        eventId,
        eventType: "PAYMENT_SUCCESS",
        payload: {
          ...eventPayload,
          userId: payment.userId || eventPayload.userId,
        },
        status: "RECEIVED",
        attemptCount: 0,
      },
    });

    await tx.eventLog.create({
      data: {
        eventId,
        status: "RECEIVED",
        message: `Payment success recorded via ${source}`,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventId,
        eventType: "PAYMENT_SUCCESS",
        payload: {
          ...eventPayload,
          userId: payment.userId || eventPayload.userId,
        },
        status: "PENDING",
        attemptCount: 0,
      },
    });

    logger.info(
      `[Payment] Created canonical event ${eventId} for payment ${razorpayPaymentId} (source=${source})`
    );

    return {
      payment,
      eventId,
      eventCreated: true,
      alreadyPaid,
    };
  }, TX_OPTIONS);
}

export async function createPaymentOrder(request: CreateOrderRequest): Promise<any> {
  try {
    const razorpay = getRazorpay();

    const options = {
      amount: request.amount, // Already in paise
      currency: "INR",
      receipt: `order_${Date.now()}_${request.userId}`,
      notes: {
        userId: request.userId,
        description: request.description,
      },
    };

    const order = await razorpay.orders.create(options);

    logger.info(`[Payment] Created Razorpay order: ${order.id} for user ${request.userId}`);

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      notes: order.notes,
    };
  } catch (error) {
    logger.error("[Payment] Error creating Razorpay order", error);
    throw error;
  }
}

export async function verifyPaymentSignature(request: VerifyPaymentRequest): Promise<boolean> {
  try {
    const keySecret = getRazorpayKeySecret();

    // Create signature string: orderId|paymentId
    const signatureBody = `${request.orderId}|${request.paymentId}`;

    // Create HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(signatureBody)
      .digest("hex");

    // Constant-time comparison so response timing does not reveal matching prefixes
    const expected = Buffer.from(expectedSignature, "hex");
    const received = Buffer.from(request.signature, "hex");
    const isValid = expected.length === received.length && crypto.timingSafeEqual(expected, received);

    if (isValid) {
      logger.info(`[Payment] Valid signature for order ${request.orderId}`);
    } else {
      logger.error(`[Payment] Invalid signature for order ${request.orderId}`);
    }

    return isValid;
  } catch (error) {
    logger.error("[Payment] Error verifying signature", error);
    throw error;
  }
}

/** The userId recorded in the order's notes when EventGuard created it, or null. */
export async function fetchOrderOwner(orderId: string): Promise<string | null> {
  try {
    const razorpay = getRazorpay();
    const order: any = await razorpay.orders.fetch(orderId);
    const owner = order?.notes?.userId;
    return typeof owner === "string" && owner.length > 0 ? owner : null;
  } catch (error) {
    logger.error(`[Payment] Error fetching order ${orderId}`, error);
    throw error;
  }
}

export async function fetchPaymentDetails(paymentId: string): Promise<any> {
  try {
    const razorpay = getRazorpay();
    const payment = await razorpay.payments.fetch(paymentId);

    logger.info(`[Payment] Fetched payment details for ${paymentId}`);

    return payment;
  } catch (error) {
    logger.error(`[Payment] Error fetching payment ${paymentId}`, error);
    throw error;
  }
}
