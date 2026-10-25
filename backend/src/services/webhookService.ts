import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import { verifyRazorpaySignature, isRazorpayConfigured } from "./razorpayService.js";

// Razorpay webhook event types
export type RazorpayEventType = "payment.captured" | "payment.failed" | string;

// Razorpay webhook payload structure (minimal for our needs).
// Live Razorpay payloads use top-level event/payload/created_at and identify
// deliveries via the X-Razorpay-Event-Id header — not payload.event_id.
export interface RazorpayWebhookPayload {
  event: string;
  entity?: string;
  account_id?: string;
  created_at?: number;
  contains?: string[];
  /** Present in some fixtures / older shapes; live payloads usually omit this. */
  event_id?: string;
  item?: {
    id?: string; // payment ID (legacy/test shape)
    entity?: string;
    [key: string]: any;
  };
  payload?: {
    payment?: {
      entity?: Record<string, any>;
    };
    [key: string]: any;
  };
  [key: string]: any;
}

/** Resolve Razorpay delivery id for idempotency (header preferred). */
export function resolveRazorpayWebhookEventId(
  payload: RazorpayWebhookPayload,
  deliveryEventId?: string | null
): string | null {
  if (deliveryEventId && String(deliveryEventId).trim()) {
    return String(deliveryEventId).trim();
  }
  if (payload.event_id && String(payload.event_id).trim()) {
    return String(payload.event_id).trim();
  }
  // Last-resort stable id when header/body id are absent
  const paymentId =
    payload.payload?.payment?.entity?.id || payload.item?.id || null;
  if (payload.event && paymentId && payload.created_at != null) {
    return `${payload.event}:${paymentId}:${payload.created_at}`;
  }
  return null;
}

export function extractWebhookPaymentId(
  payload: RazorpayWebhookPayload
): string | null {
  return (
    payload.payload?.payment?.entity?.id ||
    payload.item?.id ||
    null
  );
}

/** notes may be an object { userId } or an empty array in live Razorpay payloads. */
export function extractUserIdFromPaymentNotes(notes: unknown): string | null {
  if (!notes || Array.isArray(notes) || typeof notes !== "object") {
    return null;
  }
  const n = notes as Record<string, unknown>;
  const raw = n.userId ?? n.user_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Check if a webhook has been processed before (idempotency check)
 */
export async function isWebhookProcessed(razorpayEventId: string): Promise<boolean> {
  try {
    const existing = await prisma.webhookEvent.findUnique({
      where: { razorpayEventId },
    });
    return !!existing;
  } catch (error) {
    logger.error("[Webhook] Error checking webhook idempotency", error);
    return false;
  }
}

/**
 * Get webhook status by event ID
 */
export async function getWebhookByEventId(
  razorpayEventId: string
): Promise<any | null> {
  try {
    return await prisma.webhookEvent.findUnique({
      where: { razorpayEventId },
    });
  } catch (error) {
    logger.error(`[Webhook] Error fetching webhook ${razorpayEventId}`, error);
    return null;
  }
}

/**
 * Get webhook by internal ID
 */
export async function getWebhookById(id: string): Promise<any | null> {
  try {
    return await prisma.webhookEvent.findUnique({
      where: { id },
    });
  } catch (error) {
    logger.error(`[Webhook] Error fetching webhook ${id}`, error);
    return null;
  }
}

/**
 * List webhooks with optional filters
 */
export async function listWebhooks(
  status?: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ webhooks: any[]; total: number }> {
  try {
    const where = status ? { status: status as any } : {};

    const [webhooks, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.webhookEvent.count({ where }),
    ]);

    return { webhooks, total };
  } catch (error) {
    logger.error("[Webhook] Error listing webhooks", error);
    return { webhooks: [], total: 0 };
  }
}

/**
 * Store webhook record with initial RECEIVED status
 */
export async function createWebhookRecord(
  razorpayEventId: string,
  eventType: RazorpayEventType,
  paymentId: string | null,
  rawPayload: any
): Promise<any> {
  try {
    const webhook = await prisma.webhookEvent.create({
      data: {
        razorpayEventId,
        eventType,
        paymentId,
        status: "RECEIVED",
        rawPayload,
      },
    });

    logger.info(`[Webhook] Webhook record created: ${razorpayEventId}`);
    return webhook;
  } catch (error: any) {
    if (error.code === "P2002") {
      // Unique constraint violation - duplicate webhook
      logger.warn(`[Webhook] Duplicate webhook ignored: ${razorpayEventId}`);
    } else {
      logger.error("[Webhook] Error creating webhook record", error);
    }
    throw error;
  }
}

/**
 * Update webhook status after processing
 */
export async function updateWebhookStatus(
  razorpayEventId: string,
  status: "PROCESSED" | "IGNORED" | "FAILED",
  errorMessage?: string
): Promise<void> {
  try {
    const webhook = await prisma.webhookEvent.findUnique({
      where: { razorpayEventId },
    });

    if (!webhook) {
      logger.warn(`[Webhook] Webhook not found: ${razorpayEventId}`);
      return;
    }

    const updateData: any = {
      status,
      processedAt: new Date(),
    };

    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }

    await prisma.webhookEvent.update({
      where: { razorpayEventId },
      data: updateData,
    });

    if (status === "PROCESSED") {
      logger.info(`[Webhook] Webhook processed: ${razorpayEventId}`);
    } else if (status === "IGNORED") {
      logger.info(`[Webhook] Webhook ignored: ${razorpayEventId}`);
    } else {
      logger.error(`[Webhook] Webhook failed: ${razorpayEventId}`, errorMessage);
    }
  } catch (error) {
    logger.error("[Webhook] Error updating webhook status", error);
    throw error;
  }
}

/**
 * Verify webhook signature and store record
 *
 * Returns:
 * - { verified: true, webhook, payload } if signature is valid
 * - { verified: false, reason } if signature is invalid
 * - { verified: false, reason: "duplicate" } if webhook was already processed
 */
export async function verifyAndStoreWebhook(
  rawBody: string,
  signature: string,
  timestamp?: string,
  deliveryEventId?: string | null
): Promise<
  | { verified: true; webhook: any; payload: RazorpayWebhookPayload }
  | { verified: false; reason: string }
> {
  try {
    // First verify signature
    const isValid = verifyRazorpaySignature(rawBody, signature, timestamp);

    if (!isValid) {
      logger.warn("[Razorpay] Invalid webhook signature");
      return { verified: false, reason: "invalid_signature" };
    }

    // Parse the payload
    let payload: RazorpayWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch (parseError) {
      logger.error("[Webhook] Invalid JSON in webhook body");
      return { verified: false, reason: "invalid_json" };
    }

    // Live Razorpay: X-Razorpay-Event-Id header. Fixtures may use payload.event_id.
    const razorpayEventId = resolveRazorpayWebhookEventId(
      payload,
      deliveryEventId
    );
    const eventType = payload.event as RazorpayEventType;
    const paymentId = extractWebhookPaymentId(payload);

    if (!razorpayEventId) {
      logger.error(
        "[Webhook] Missing webhook delivery id (X-Razorpay-Event-Id / event_id)"
      );
      return { verified: false, reason: "missing_event_id" };
    }

    // Normalize so downstream handlers can rely on payload.event_id
    payload.event_id = razorpayEventId;

    // Check for duplicate webhook (idempotency level 1)
    const isDuplicate = await isWebhookProcessed(razorpayEventId);

    if (isDuplicate) {
      logger.warn(`[Webhook] Duplicate webhook ignored: ${razorpayEventId}`);
      return { verified: false, reason: "duplicate" };
    }

    // Store webhook record with RECEIVED status
    const webhook = await createWebhookRecord(
      razorpayEventId,
      eventType,
      paymentId,
      payload
    );

    return { verified: true, webhook, payload };
  } catch (error) {
    logger.error("[Webhook] Error verifying webhook", error);
    return { verified: false, reason: "error" };
  }
}

/**
 * Check if a Razorpay payment was already processed
 * (for handling both frontend verification and webhook scenarios)
 */
export async function isPaymentProcessed(
  razorpayPaymentId: string
): Promise<boolean> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { razorpayPaymentId },
    });

    if (!payment) {
      return false;
    }

    // If payment is PAID, it was already processed
    return payment.status === "PAID";
  } catch (error) {
    logger.error(`[Webhook] Error checking payment ${razorpayPaymentId}`, error);
    return false;
  }
}

/**
 * Create or update a payment record
 */
export async function createOrUpdatePayment(
  razorpayPaymentId: string,
  razorpayOrderId: string | null,
  orderNumber: string | null,
  userId: string | null,
  amount: number,
  currency: string,
  status: "PAID" | "FAILED",
  rawPayload: any
): Promise<any> {
  try {
    const existing = await prisma.payment.findUnique({
      where: { razorpayPaymentId },
    });

    // Never downgrade PAID → FAILED
    if (existing?.status === "PAID" && status === "FAILED") {
      logger.info(
        `[Webhook] Skipping FAILED update for already-PAID payment ${razorpayPaymentId}`
      );
      return existing;
    }

    const payment = await prisma.payment.upsert({
      where: { razorpayPaymentId },
      update: {
        status,
        amount,
        currency,
        errorMessage: null,
        metadata: rawPayload,
        updatedAt: new Date(),
      },
      create: {
        razorpayPaymentId,
        razorpayOrderId,
        orderNumber,
        userId,
        amount,
        currency,
        status,
        metadata: rawPayload,
      },
    });

    logger.info(`[Webhook] Payment ${status}: ${razorpayPaymentId}`);
    return payment;
  } catch (error) {
    logger.error("[Webhook] Error creating/updating payment", error);
    throw error;
  }
}

/**
 * Get a payment by Razorpay payment ID
 */
export async function getPaymentByRazorpayId(
  razorpayPaymentId: string
): Promise<any | null> {
  try {
    return await prisma.payment.findUnique({
      where: { razorpayPaymentId },
    });
  } catch (error) {
    logger.error(`[Webhook] Error fetching payment ${razorpayPaymentId}`, error);
    return null;
  }
}

/**
 * Check if webhook processing is configured
 */
export function isWebhookProcessingEnabled(): boolean {
  return isRazorpayConfigured();
}