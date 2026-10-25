import crypto from "crypto";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

/**
 * Verify Razorpay webhook signature
 *
 * Razorpay uses HMAC-SHA256 signature verification.
 * The signature is computed from: webhook_id + "." + timestamp + "." + payload
 * Or simply: timestamp + "." + payload (depending on Razorpay version)
 *
 * @param payload - Raw request body (string)
 * @param signature - X-Razorpay-Signature header value
 * @param timestamp - X-Razorpay-Timestamp header value (optional, for newer webhooks)
 * @returns true if signature is valid, false otherwise
 */
export function verifyRazorpaySignature(
  payload: string,
  signature: string,
  timestamp?: string
): boolean {
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

    // For Razorpay webhooks, the signature is computed as:
    // HMAC-SHA256 of payload using webhook_secret
    // Some versions include timestamp: hmac_sha256(timestamp + "." + payload, secret)
    let dataToVerify: string;

    if (timestamp) {
      // Newer Razorpay format: timestamp.payload
      dataToVerify = `${timestamp}.${payload}`;
    } else {
      // Legacy format: just the payload
      dataToVerify = payload;
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(dataToVerify, "utf8")
      .digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      logger.warn("[Razorpay] Invalid webhook signature");
    }

    return isValid;
  } catch (error) {
    // If buffer lengths don't match, timingSafeEqual throws
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