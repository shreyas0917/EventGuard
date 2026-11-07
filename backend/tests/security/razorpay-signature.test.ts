// Set the webhook secret before src/config is imported so config picks it up.
const WEBHOOK_SECRET = "whsec_unit_0123456789abcdef";
Object.assign(process.env, {
  RAZORPAY_KEY_ID: "rzp_test_unit",
  RAZORPAY_KEY_SECRET: "rzp_key_secret_unit",
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

import crypto from "crypto";
import { describe, it, expect } from "vitest";

const { verifyRazorpaySignature } = await import("../../src/services/razorpayService.js");

const sign = (body: string) => crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

describe("verifyRazorpaySignature (raw body, no timestamp)", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } });

  it("accepts a valid hex signature over the raw body", () => {
    expect(verifyRazorpaySignature(body, sign(body))).toBe(true);
  });

  it("rejects a signature for a tampered body", () => {
    expect(verifyRazorpaySignature(body + " ", sign(body))).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const other = crypto.createHmac("sha256", "wrong-secret").update(body).digest("hex");
    expect(verifyRazorpaySignature(body, other)).toBe(false);
  });

  it.each([
    ["an empty signature", ""],
    ["a non-hex signature", "not-a-hex-signature"],
    ["a truncated signature", sign(body).slice(0, 10)],
    ["an over-long signature", sign(body) + "00"],
  ])("rejects %s without throwing", (_name, sig) => {
    expect(verifyRazorpaySignature(body, sig)).toBe(false);
  });

  it("does not accept a timestamp-prefixed signature (timestamp support removed)", () => {
    const withTs = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`169.${body}`).digest("hex");
    expect(verifyRazorpaySignature(body, withTs)).toBe(false);
  });
});
