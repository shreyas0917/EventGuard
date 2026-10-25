import Razorpay from "razorpay";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let razorpayInstance: Razorpay | null = null;
let razorpayKeySecret: string | null = null;

export function initializeRazorpay() {
  try {
    // Check if credentials are actually provided (not empty strings)
    const hasKeyId = config.razorpay_key_id && config.razorpay_key_id.trim().length > 0;
    const hasKeySecret = config.razorpay_key_secret && config.razorpay_key_secret.trim().length > 0;

    if (!hasKeyId || !hasKeySecret) {
      logger.info("[Razorpay] Credentials not configured - Razorpay integration disabled");
      return false;
    }

    razorpayInstance = new Razorpay({
      key_id: config.razorpay_key_id,
      key_secret: config.razorpay_key_secret,
    });

    // Store the key secret separately for HMAC verification
    razorpayKeySecret = config.razorpay_key_secret;

    logger.info("[Razorpay] Initialized with TEST credentials");
    return true;
  } catch (error) {
    logger.error("[Razorpay] Initialization failed", error);
    return false;
  }
}

export function getRazorpay(): Razorpay {
  if (!razorpayInstance) {
    throw new Error("Razorpay not initialized");
  }
  return razorpayInstance;
}

export function getRazorpayKeySecret(): string {
  if (!razorpayKeySecret) {
    throw new Error("Razorpay key secret not available - Razorpay not initialized");
  }
  return razorpayKeySecret;
}

export function isRazorpayConfigured(): boolean {
  return razorpayInstance !== null;
}
