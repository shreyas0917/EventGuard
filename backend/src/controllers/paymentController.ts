import { Request, Response } from "express";
import {
  createPaymentOrder,
  verifyPaymentSignature,
  fetchPaymentDetails,
  ensurePaymentSuccessEvent,
} from "../services/paymentService.js";
import { getEventByEventId } from "../services/eventService.js";
import { logger } from "../lib/logger.js";

export async function handleCreateOrder(req: Request, res: Response): Promise<void> {
  try {
    const { userId, amount, description } = req.body;

    if (!userId || !amount || !description) {
      res.status(400).json({
        error: "Missing required fields: userId, amount, description",
      });
      return;
    }

    if (amount <= 0) {
      res.status(400).json({ error: "Amount must be positive" });
      return;
    }

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
    const { orderId, paymentId, signature, userId } = req.body;

    if (!orderId || !paymentId || !signature || !userId) {
      res.status(400).json({
        error: "Missing required fields: orderId, paymentId, signature, userId",
      });
      return;
    }

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
