import crypto from "crypto";
import { prisma } from "../src/lib/prisma.js";
import { verifyRazorpaySignature } from "../src/services/razorpayService.js";
import { logger } from "../src/lib/logger.js";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "test_webhook_secret";
const API_BASE = "http://localhost:3001";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[Phase 9 Test] ${message}`);
}

function createSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * TEST 1: Valid signature verification
 */
async function testValidSignature() {
  try {
    log("TEST 1: Valid signature verification");

    const payload = JSON.stringify({
      event: "payment.captured",
      event_id: "evt_valid_sig_1",
      payload: {
        payment: {
          entity: {
            id: "pay_valid_1",
            order_id: "order_valid_1",
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const signature = createSignature(payload, WEBHOOK_SECRET);
    const isValid = verifyRazorpaySignature(payload, signature);

    if (isValid) {
      log("✓ Valid signature accepted");
      results.push({ name: "Valid signature verification", passed: true });
    } else {
      throw new Error("Valid signature was rejected");
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Valid signature verification",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 2: Invalid signature rejection
 */
async function testInvalidSignature() {
  try {
    log("TEST 2: Invalid signature rejection");

    const payload = JSON.stringify({
      event: "payment.captured",
      event_id: "evt_invalid_sig_1",
      payload: {
        payment: {
          entity: {
            id: "pay_invalid_1",
            order_id: "order_invalid_1",
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const invalidSignature = "invalid_signature_hex";
    const isValid = verifyRazorpaySignature(payload, invalidSignature);

    if (!isValid) {
      log("✓ Invalid signature rejected");
      results.push({ name: "Invalid signature rejection", passed: true });
    } else {
      throw new Error("Invalid signature was accepted");
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Invalid signature rejection",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 3: Modified payload with old signature
 */
async function testModifiedPayload() {
  try {
    log("TEST 3: Modified payload with old signature");

    const originalPayload = JSON.stringify({
      event: "payment.captured",
      event_id: "evt_modified_1",
      payload: {
        payment: {
          entity: {
            id: "pay_original_1",
            order_id: "order_modified_1",
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const signature = createSignature(originalPayload, WEBHOOK_SECRET);

    // Modify the payload
    const modifiedPayload = JSON.stringify({
      event: "payment.captured",
      event_id: "evt_modified_1",
      payload: {
        payment: {
          entity: {
            id: "pay_modified_1", // Changed
            order_id: "order_modified_1",
            amount: 100000, // Changed
            currency: "INR",
          },
        },
      },
    });

    const isValid = verifyRazorpaySignature(modifiedPayload, signature);

    if (!isValid) {
      log("✓ Modified payload rejected");
      results.push({ name: "Modified payload with old signature", passed: true });
    } else {
      throw new Error("Modified payload was accepted");
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Modified payload with old signature",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 4: Webhook idempotency - duplicate webhook ignored
 */
async function testWebhookIdempotency() {
  try {
    log("TEST 4: Webhook idempotency - same webhook twice");

    const webhookEventId = `evt_idempotency_test_${Date.now()}`;
    const payload = JSON.stringify({
      event: "payment.captured",
      event_id: webhookEventId,
      payload: {
        payment: {
          entity: {
            id: `pay_idempotency_${Date.now()}`,
            order_id: `order_idempotency_${Date.now()}`,
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const signature = createSignature(payload, WEBHOOK_SECRET);

    // Send webhook first time
    log(`  Sending webhook: ${webhookEventId}`);
    const response1 = await fetch(`${API_BASE}/api/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": signature,
      },
      body: payload,
    });

    if (response1.status !== 200) {
      throw new Error(`First webhook failed: ${response1.status}`);
    }

    // Send same webhook second time
    log(`  Resending same webhook: ${webhookEventId}`);
    const response2 = await fetch(`${API_BASE}/api/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": signature,
      },
      body: payload,
    });

    if (response2.status !== 200) {
      throw new Error(`Second webhook failed: ${response2.status}`);
    }

    // Check database - should have only one WebhookEvent
    const webhookRecords = await prisma.webhookEvent.findMany({
      where: { razorpayEventId: webhookEventId },
    });

    if (webhookRecords.length === 1) {
      log(`✓ Duplicate webhook ignored (1 record in database)`);
      results.push({ name: "Webhook idempotency", passed: true });
    } else {
      throw new Error(
        `Expected 1 webhook record, found ${webhookRecords.length}`
      );
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Webhook idempotency",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 5: Concurrent webhook requests
 */
async function testConcurrentWebhooks() {
  try {
    log("TEST 5: Concurrent webhook requests (20x simultaneous)");

    const webhookEventId = `evt_concurrent_${Date.now()}`;
    const paymentId = `pay_concurrent_${Date.now()}`;
    const payload = JSON.stringify({
      event: "payment.captured",
      event_id: webhookEventId,
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: `order_concurrent_${Date.now()}`,
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const signature = createSignature(payload, WEBHOOK_SECRET);

    // Send 20 concurrent requests
    const requests = Array(20)
      .fill(null)
      .map(() =>
        fetch(`${API_BASE}/api/webhooks/razorpay`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Razorpay-Signature": signature,
          },
          body: payload,
        })
      );

    const responses = await Promise.all(requests);
    const allSuccessful = responses.every((r) => r.status === 200);

    if (!allSuccessful) {
      throw new Error("Some concurrent requests failed");
    }

    // Check database - should have only one payment record
    const payments = await prisma.payment.findMany({
      where: { razorpayPaymentId: paymentId },
    });

    if (payments.length === 1) {
      log(`✓ Concurrent webhooks handled correctly (1 payment record)`);
      results.push({ name: "Concurrent webhook requests", passed: true });
    } else {
      throw new Error(`Expected 1 payment record, found ${payments.length}`);
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Concurrent webhook requests",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 6: Payment status transitions
 */
async function testPaymentStatusTransition() {
  try {
    log("TEST 6: Payment.captured creates PAID status");

    const paymentId = `pay_status_${Date.now()}`;
    const webhookEventId = `evt_status_${Date.now()}`;
    const payload = JSON.stringify({
      event: "payment.captured",
      event_id: webhookEventId,
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: `order_status_${Date.now()}`,
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const signature = createSignature(payload, WEBHOOK_SECRET);

    const response = await fetch(`${API_BASE}/api/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": signature,
      },
      body: payload,
    });

    if (response.status !== 200) {
      throw new Error(`Webhook failed: ${response.status}`);
    }

    // Check payment status
    const payment = await prisma.payment.findUnique({
      where: { razorpayPaymentId: paymentId },
    });

    if (payment?.status === "PAID") {
      log(`✓ Payment status set to PAID`);
      results.push({ name: "Payment status transition", passed: true });
    } else {
      throw new Error(`Expected status PAID, got ${payment?.status}`);
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Payment status transition",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 7: Webhook listing API
 */
async function testWebhookListingAPI() {
  try {
    log("TEST 7: Webhook listing API");

    const response = await fetch(`${API_BASE}/api/webhooks/razorpay?limit=5`);

    if (response.status !== 200) {
      throw new Error(`API call failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.success && Array.isArray(data.data)) {
      log(`✓ Webhook listing API works (${data.data.length} webhooks)`);
      results.push({ name: "Webhook listing API", passed: true });
    } else {
      throw new Error("Invalid API response format");
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Webhook listing API",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * TEST 8: Missing signature header
 */
async function testMissingSignature() {
  try {
    log("TEST 8: Missing signature header");

    const payload = JSON.stringify({
      event: "payment.captured",
      event_id: `evt_no_sig_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_no_sig_${Date.now()}`,
            order_id: `order_no_sig_${Date.now()}`,
            amount: 50000,
            currency: "INR",
          },
        },
      },
    });

    const response = await fetch(`${API_BASE}/api/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Missing X-Razorpay-Signature
      },
      body: payload,
    });

    if (response.status === 401) {
      log(`✓ Missing signature rejected with 401`);
      results.push({ name: "Missing signature header", passed: true });
    } else {
      throw new Error(`Expected 401, got ${response.status}`);
    }
  } catch (error) {
    log(`✗ Test failed: ${error}`);
    results.push({
      name: "Missing signature header",
      passed: false,
      error: String(error),
    });
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  log("=== Phase 9: Razorpay Webhooks Test Suite ===\n");

  try {
    await testValidSignature();
    await testInvalidSignature();
    await testModifiedPayload();
    await testMissingSignature();
    await testWebhookIdempotency();
    await testConcurrentWebhooks();
    await testPaymentStatusTransition();
    await testWebhookListingAPI();

    log("\n=== Test Summary ===\n");

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    results.forEach((r) => {
      const status = r.passed ? "✓ PASS" : "✗ FAIL";
      log(`${status}: ${r.name}`);
      if (r.error) {
        log(`   Error: ${r.error}`);
      }
    });

    log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

    if (failed === 0) {
      log("🎉 All Phase 9 tests passed!");
      process.exit(0);
    } else {
      log("❌ Some tests failed");
      process.exit(1);
    }
  } catch (error) {
    log(`Unexpected error: ${error}`);
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error) => {
  log(`Fatal error: ${error}`);
  process.exit(1);
});