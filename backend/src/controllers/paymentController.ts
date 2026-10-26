import { Request, Response } from "express";
import {
  createPaymentOrder,
  verifyPaymentSignature,
  fetchPaymentDetails,
  fetchOrderOwner,
  ensurePaymentSuccessEvent,
} from "../services/paymentService.js";
import { getEventByEventId } from "../services/eventService.js";
import { logger } from "../lib/logger.js";
import { resolveTargetUser } from "../middleware/auth.js";

export async function handleCreateOrder(req: Request, res: Response): Promise<void> {
  try {
    // Body is validated by createOrderBody; the order is owned by the caller
    const { amount, description } = req.body;
    const userId = resolveTargetUser(req, res, req.body.userId);
    if (!userId) return;

    // Frontend sends amount in INR, convert to paise for Razorpay
    const amountInPaise = Math.round(amount * 100);

    const order = await createPaymentOrder({
      userId,
      amount: amountInPaise,
      description,
    });

    res.status(201).json({
      success: true,
      order,
    });
  } catch (error) {
    logger.error("[Controller] Error creating order", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create order",
    });
  }
}

export async function handleVerifyPayment(req: Request, res: Response): Promise<void> {
  try {
    // Body is validated by verifyPaymentBody; the credit always goes to the authenticated caller
    const { orderId, paymentId, signature } = req.body;
    const userId = resolveTargetUser(req, res, req.body.userId);
    if (!userId) return;

    // Verify Razorpay signature
    const isSignatureValid = await verifyPaymentSignature({
      orderId,
      paymentId,
      signature,
      userId,
    });

    if (!isSignatureValid) {
      logger.warn(`[Controller] Invalid signature for order ${orderId}`);
      res.status(400).json({
        error: "Invalid payment signature",
        verified: false,
      });
      return;
    }

    // The order must belong to the user being credited. Orders record their owner in
    // notes.userId at creation, so a valid signature for someone else's order is refused.
    const orderOwner = await fetchOrderOwner(orderId);
    if (orderOwner !== userId) {
      logger.warn(`[Controller] Order ${orderId} does not belong to ${userId}`, {
        requestId: (req as any).requestId,
      });
      res.status(403).json({
        success: false,
        error: { code: "ORDER_OWNERSHIP_MISMATCH", message: "This order belongs to a different user" },
        verified: false,
      });
      return;
    }

    // Fetch payment details from Razorpay
    const paymentDetails = await fetchPaymentDetails(paymentId);

    if (paymentDetails.status !== "captured") {
      logger.warn(`[Controller] Payment not captured: ${paymentId}`);
      res.status(400).json({
        error: "Payment not captured",
        verified: false,
        status: paymentDetails.status,
      });
      return;
    }

    const amount = paymentDetails.amount / 100; // Convert paise to INR

    const result = await ensurePaymentSuccessEvent({
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      userId,
      amount,
      currency: paymentDetails.currency || "INR",
      metadata: {
        description: paymentDetails.description,
        razorpayStatus: paymentDetails.status,
      },
      source: "verify",
    });

    const event = await getEventByEventId(result.eventId);

    logger.info(
      `[Controller] Payment verify idempotent for ${paymentId}: event=${result.eventId} created=${result.eventCreated}`
    );

    res.status(result.eventCreated ? 201 : 200).json({
      success: true,
      verified: true,
      message: result.eventCreated
        ? "Payment verified and event created"
        : "Payment already recorded (idempotent)",
      event: {
        eventId: result.eventId,
        eventType: event?.eventType || "PAYMENT_SUCCESS",
        status: event?.status || "RECEIVED",
        amount,
      },
      payment: {
        razorpayPaymentId: paymentId,
        status: result.payment.status,
      },
      idempotent: !result.eventCreated,
    });
  } catch (error) {
    logger.error("[Controller] Error verifying payment", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to verify payment",
      verified: false,
    });
  }
}
