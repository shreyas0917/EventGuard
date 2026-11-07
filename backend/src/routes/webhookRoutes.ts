import { Router, Request, Response } from "express";
import {
  verifyAndStoreWebhook,
  updateWebhookStatus,
  createOrUpdatePayment,
  isPaymentProcessed,
  listWebhooks,
  getWebhookById,
  isWebhookProcessingEnabled,
  extractUserIdFromPaymentNotes,
} from "../services/webhookService.js";
import { ensurePaymentSuccessEvent, fetchOrderOwner } from "../services/paymentService.js";
import { logger } from "../lib/logger.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { webhooksReceived } from "../lib/metrics.js";
import { validate } from "../middleware/validate.js";
import { webhookIdParams, webhookListQuery } from "../validation/schemas.js";

const router = Router();

/**
 * POST /api/webhooks/razorpay
 *
 * Handle Razorpay webhook events.
 *
 * This endpoint:
 * 1. Verifies Razorpay signature
 * 2. Checks webhook idempotency (prevents duplicate processing)
 * 3. Processes payment.captured and payment.failed events
 * 4. Creates EventGuard PAYMENT_SUCCESS event via transactional outbox
 * 5. Returns quickly (actual wallet processing is async via Kafka)
 */
router.post(
  "/razorpay",
  async (req: Request, res: Response): Promise<void> => {
    try {
      logger.info("[Razorpay] Webhook received");

      // Check if webhook processing is enabled
      if (!isWebhookProcessingEnabled()) {
        logger.warn("[Razorpay] Webhook processing not configured");
        res.status(503).json({
          success: false,
          error: "Webhook processing not configured",
        });
        return;
      }

      // HMAC must use the original request bytes (captured by express.json verify),
      // never JSON.stringify(req.body) — serialization can differ from what Razorpay signed.
      if (!req.rawBody || req.rawBody.length === 0) {
        logger.warn("[Razorpay] Missing raw request body for signature verification");
        res.status(400).json({
          success: false,
          error: "Missing request body",
        });
        return;
      }
      const rawBody = req.rawBody.toString("utf8");

      // Get signature from header
      const signature = req.headers["x-razorpay-signature"] as string;
      // Live Razorpay delivery id (preferred over body.event_id, which is often absent)
      const deliveryEventIdHeader = req.headers["x-razorpay-event-id"];
      const deliveryEventId = Array.isArray(deliveryEventIdHeader)
        ? deliveryEventIdHeader[0]
        : deliveryEventIdHeader;

      if (!signature) {
        logger.warn("[Razorpay] Missing signature header");
        res.status(401).json({
          success: false,
          error: "Missing signature",
        });
        return;
      }

      // Verify signature and store webhook record
      const result = await verifyAndStoreWebhook(
        rawBody,
        signature,
        deliveryEventId
      );

      if (!result.verified) {
        if (result.reason === "duplicate") {
          webhooksReceived.inc({ result: "duplicate" });
          // Duplicate webhook - acknowledge but don't process
          res.status(200).json({
            success: true,
            message: "Webhook already processed",
          });
          return;
        }

        webhooksReceived.inc({ result: "rejected" });
        // Invalid signature or other error
        res.status(401).json({
          success: false,
          error: "Invalid webhook",
        });
        return;
      }

      const { webhook, payload } = result;
      const eventType = payload.event;
      // The stored record carries the delivery id resolved from X-Razorpay-Event-Id;
      // live payloads usually have no body event_id.
      const razorpayEventId: string = webhook.razorpayEventId;

      logger.info(`[Razorpay] Signature verified for event: ${razorpayEventId}`);

      // Handle different event types
      if (eventType === "payment.captured") {
        await handlePaymentCaptured(webhook, payload);
      } else if (eventType === "payment.failed") {
        await handlePaymentFailed(webhook, payload);
      } else {
        // Unsupported event type - mark as ignored
        await updateWebhookStatus(razorpayEventId, "IGNORED");
        logger.info(`[Razorpay] Unsupported event type ignored: ${eventType}`);
      }

      webhooksReceived.inc({ result: eventType === "payment.captured" || eventType === "payment.failed" ? "processed" : "ignored" });
      // Return success - wallet processing continues asynchronously
      res.status(200).json({
        success: true,
        message: "Webhook received",
      });
    } catch (error) {
      logger.error("[Razorpay] Webhook processing error", error);
      res.status(500).json({
        success: false,
        error: "Webhook processing failed",
      });
    }
  }
);

/**
 * Handle payment.captured webhook
 */
async function handlePaymentCaptured(
  webhook: any,
  payload: any
): Promise<void> {
  const razorpayEventId = payload.event_id;
  const paymentData = payload.payload?.payment?.entity || payload.item || {};

  const razorpayPaymentId = paymentData.id;
  const razorpayOrderId = paymentData.order_id || null;
  const amount = paymentData.amount; // In paise
  const currency = paymentData.currency || "INR";

  if (!razorpayPaymentId) {
    await updateWebhookStatus(
      razorpayEventId,
      "FAILED",
      "Missing payment ID in webhook"
    );
    return;
  }

  // The userId lives on the ORDER's notes (set in createPaymentOrder), not the payment's.
  // Live payment.captured payloads usually have notes: []. Resolve the owner from the order
  // so we never credit a fabricated `user_<paymentId>`.
  let userId = extractUserIdFromPaymentNotes(paymentData.notes);
  if (!userId && razorpayOrderId) {
    userId = await fetchOrderOwner(razorpayOrderId);
  }

  if (!userId) {
    // No owner anywhere: do NOT create the event. Mark FAILED and throw so the route
    // answers non-2xx and Razorpay (or a later /verify) can retry with better data.
    const reason = `Cannot resolve owner for payment ${razorpayPaymentId} (no userId in payment or order notes)`;
    await updateWebhookStatus(razorpayEventId, "FAILED", reason);
    throw new Error(reason);
  }

  try {
    // Fast path: already PAID (e.g. checkout verify won). Still durable-checked inside ensure*.
    const alreadyProcessed = await isPaymentProcessed(razorpayPaymentId);
    if (alreadyProcessed) {
      logger.info(
        `[Razorpay] Payment already PAID, ensuring canonical event exists: ${razorpayPaymentId}`
      );
    }

    const result = await ensurePaymentSuccessEvent({
      razorpayPaymentId,
      razorpayOrderId,
      userId,
      amount: amount / 100,
      currency,
      metadata: paymentData,
      source: "webhook",
    });

    logger.info(
      `[Razorpay] payment.captured handled: payment=${razorpayPaymentId} event=${result.eventId} created=${result.eventCreated}`
    );

    await updateWebhookStatus(razorpayEventId, "PROCESSED");
  } catch (error) {
    logger.error(
      `[Razorpay] Failed to process payment.captured: ${razorpayPaymentId}`,
      error
    );
    await updateWebhookStatus(
      razorpayEventId,
      "FAILED",
      error instanceof Error ? error.message : "Unknown error"
    );
    // Rethrow so the route answers 500: Razorpay only resends after a non-2xx, which
    // lets verifyAndStoreWebhook reprocess the FAILED delivery on the next attempt.
    throw error;
  }
}

/**
 * Handle payment.failed webhook
 */
async function handlePaymentFailed(webhook: any, payload: any): Promise<void> {
  const razorpayEventId = payload.event_id;
  const paymentData = payload.payload?.payment?.entity || payload.item || {};

  const razorpayPaymentId = paymentData.id;
  const razorpayOrderId = paymentData.order_id;
  const amount = paymentData.amount;
  const currency = paymentData.currency || "INR";

  if (!razorpayPaymentId) {
    await updateWebhookStatus(
      razorpayEventId,
      "FAILED",
      "Missing payment ID in webhook"
    );
    return;
  }

  try {
    // Fast path only: skip the write when the payment is already clearly PAID. The real
    // guard against a PAID→FAILED downgrade is the advisory lock inside createOrUpdatePayment,
    // which also covers a verify/capture that commits PAID after this check.
    if (await isPaymentProcessed(razorpayPaymentId)) {
      logger.info(
        `[Razorpay] Ignoring payment.failed for already-PAID payment ${razorpayPaymentId}`
      );
      await updateWebhookStatus(razorpayEventId, "PROCESSED");
      return;
    }

    await createOrUpdatePayment(
      razorpayPaymentId,
      razorpayOrderId,
      null,
      null,
      amount / 100,
      currency,
      "FAILED",
      paymentData
    );

    await updateWebhookStatus(razorpayEventId, "PROCESSED");

    logger.info(`[Razorpay] Payment failed recorded: ${razorpayPaymentId}`);
  } catch (error) {
    logger.error(
      `[Razorpay] Failed to process payment.failed: ${razorpayPaymentId}`,
      error
    );
    await updateWebhookStatus(
      razorpayEventId,
      "FAILED",
      error instanceof Error ? error.message : "Unknown error"
    );
    // Rethrow so the route answers 500 and Razorpay resends (see handlePaymentCaptured).
    throw error;
  }
}

/**
 * GET /api/webhooks/razorpay
 *
 * List recent webhook records
 */
router.get(
  "/razorpay",
  authenticate,
  requireRole("admin"),
  validate({ query: webhookListQuery }),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, limit, offset } = req.query as unknown as {
      status?: string;
      limit: number;
      offset: number;
    };

    const result = await listWebhooks(status, limit, offset);

    res.json({
      success: true,
      data: result.webhooks,
      total: result.total,
    });
  } catch (error) {
    logger.error("[Webhook] Error listing webhooks", error);
    res.status(500).json({
      success: false,
      error: "Failed to list webhooks",
    });
  }
  }
);

/**
 * GET /api/webhooks/razorpay/:id
 *
 * Get webhook details by ID
 */
router.get(
  "/razorpay/:id",
  authenticate,
  requireRole("admin"),
  validate({ params: webhookIdParams }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;

      const webhook = await getWebhookById(id);

      if (!webhook) {
        res.status(404).json({
          success: false,
          error: "Webhook not found",
        });
        return;
      }

      res.json({
        success: true,
        data: webhook,
      });
    } catch (error) {
      logger.error("[Webhook] Error fetching webhook", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch webhook",
      });
    }
  }
);

export default router;
