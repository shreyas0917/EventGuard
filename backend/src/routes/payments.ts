import { Router } from "express";
import { handleCreateOrder, handleVerifyPayment } from "../controllers/paymentController.js";
import { getRazorpayKeyId } from "../services/razorpayService.js";

const router = Router();

// GET /api/payments/config
// Returns Razorpay configuration for frontend checkout
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
// Create a Razorpay order for payment
router.post("/create-order", handleCreateOrder);

// POST /api/payments/verify
// Verify Razorpay payment signature and create PAYMENT_SUCCESS event
router.post("/verify", handleVerifyPayment);

export default router;
