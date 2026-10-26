import { Router } from "express";
import { handleCreateOrder, handleVerifyPayment } from "../controllers/paymentController.js";
import { getRazorpayKeyId } from "../services/razorpayService.js";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createOrderBody, verifyPaymentBody } from "../validation/schemas.js";

const router = Router();

// GET /api/payments/config (public)
// Returns Razorpay configuration for frontend checkout: the publishable key id only
router.get("/config", (req, res) => {
  const keyId = getRazorpayKeyId();
  if (!keyId) {
    res.status(503).json({
      error: "Razorpay not configured",
      configured: false,
    });
    return;
  }
  res.json({
    configured: true,
    keyId,
  });
});

// POST /api/payments/create-order
// Create a Razorpay order owned by the authenticated user
router.post("/create-order", authenticate, validate({ body: createOrderBody }), handleCreateOrder);

// POST /api/payments/verify
// Verify Razorpay payment signature and create PAYMENT_SUCCESS event for the order's owner
router.post("/verify", authenticate, validate({ body: verifyPaymentBody }), handleVerifyPayment);

export default router;
