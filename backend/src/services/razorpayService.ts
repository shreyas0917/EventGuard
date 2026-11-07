import crypto from "crypto";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

/**
 * Verify a Razorpay webhook signature.
 *
 * Razorpay signs the raw request body with HMAC-SHA256 and sends the hex digest in
 * X-Razorpay-Signature. There is no timestamp in the signed data.
 *
 * @param payload - Raw request body (string)
 * @param signature - X-Razorpay-Signature header value (hex)
 * @returns true if the signature is valid, false otherwise
 */
export function verifyRazorpaySignature(payload: string, signature: string): boolean {
  try {
    const webhookSecret = config.razorpay_webhook_secret;

    if (!webhookSecret) {
      logger.warn("[Razorpay] Webhook secret not configured");
      return false;
    }

    if (!signature) {
      logger.warn("[Razorpay] Missing signature header");
      return false;
    }

    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(payload, "utf8")
      .digest();
    const received = Buffer.from(signature, "hex");

    // Check lengths first: timingSafeEqual throws on a length mismatch, and a non-hex
    // signature decodes to a shorter buffer.
    const isValid = received.length === expected.length && crypto.timingSafeEqual(received, expected);

    if (!isValid) {
      logger.warn("[Razorpay] Invalid webhook signature");
    }

    return isValid;
  } catch (error) {
    logger.warn("[Razorpay] Signature verification error");
    return false;
  }
}

/**
 * Check if Razorpay credentials are configured
 */
export function isRazorpayConfigured(): boolean {
  return !!(
    config.razorpay_key_id &&
    config.razorpay_key_secret &&
    config.razorpay_webhook_secret
  );
}

/**
 * Get Razorpay key ID (for frontend checkout)
 */
export function getRazorpayKeyId(): string | undefined {
  return config.razorpay_key_id;
}