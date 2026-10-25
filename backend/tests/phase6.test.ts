import { prisma } from "../src/lib/prisma.js";
import { createEvent } from "../src/services/eventService.js";
import { creditWallet, getWallet, createWallet, getWalletTransactionByEventId } from "../src/services/walletService.js";
import { verifyPaymentSignature } from "../src/services/paymentService.js";
import { processEvent } from "../src/kafka/eventWorker.js";
import { getRazorpayKeySecret } from "../src/lib/razorpay.js";

describe("Phase 6: Business Operations and Razorpay Integration", () => {
  const TEST_USER_ID = "test-user-phase6";

  beforeAll(async () => {
    process.env.RAZORPAY_KEY_ID = "test_key_id_123";
    process.env.RAZORPAY_KEY_SECRET = "test_key_secret_123";
    process.env.RAZORPAY_TEST_MODE = "true";
  });

  afterAll(async () => {
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: TEST_USER_ID } },
    });
    await prisma.wallet.deleteMany({
      where: { userId: TEST_USER_ID },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: TEST_USER_ID } },
    });
    await prisma.wallet.deleteMany({
      where: { userId: TEST_USER_ID },
    });
  });

  it("should create wallet for user", async () => {
    const wallet = await createWallet(TEST_USER_ID);
    expect(wallet).toBeDefined();
    expect(wallet.userId).toBe(TEST_USER_ID);
    expect(parseFloat(wallet.balance)).toBe(0);
  });

  it("should credit wallet with atomic transaction", async () => {
    const wallet = await createWallet(TEST_USER_ID);
    const eventId = "test_credit_event_1";
    const amount = 100;

    const result = await creditWallet(TEST_USER_ID, amount, eventId, "Test credit");
    expect(result.walletTransaction.eventId).toBe(eventId);
    expect(result.walletTransaction.type).toBe("CREDIT");
    expect(parseFloat(result.walletTransaction.amount)).toBe(amount);
    expect(parseFloat(result.wallet.balance)).toBe(amount);
  });

  it("should prevent duplicate credits via WalletTransaction.eventId UNIQUE constraint", async () => {
    const wallet = await createWallet(TEST_USER_ID);
    const eventId = "test_duplicate_event_1";
    const amount = 50;

    await creditWallet(TEST_USER_ID, amount, eventId, "First credit");

    await expect(creditWallet(TEST_USER_ID, amount, eventId, "Duplicate credit")).rejects.toThrow();

    const finalWallet = await getWallet(TEST_USER_ID);
    expect(parseFloat(finalWallet.balance)).toBe(amount);
  });

  it("should generate valid HMAC-SHA256 signature verification", async () => {
    const orderId = "order_test_123";
    const paymentId = "pay_test_456";
    const keySecret = getRazorpayKeySecret();

    const expectedSignature = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");

    const isSignatureValid = await verifyPaymentSignature({ orderId, paymentId, signature: expectedSignature, userId: TEST_USER_ID });
    expect(isSignatureValid).toBe(true);
  });

  it("should reject invalid signature", async () => {
    const isSignatureValid = await verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature: "invalid_sig", userId: TEST_USER_ID });
    expect(isSignatureValid).toBe(false);
  });

  it("should process PAYMENT_SUCCESS event and credit wallet", async () => {
    await createWallet(TEST_USER_ID);
    const eventId = "evt_payment_test_1";
    const payload = { userId: TEST_USER_ID, paymentId: "pay_test_1", orderId: "order_test_1", amount: 150, currency: "INR", description: "Test payment" };

    await createEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload });
    await processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload });

    const transaction = await getWalletTransactionByEventId(eventId);
    expect(transaction).toBeDefined();
    expect(transaction.eventId).toBe(eventId);
    expect(parseFloat(transaction.amount)).toBe(150);
  });

  it("should handle 100 duplicate event deliveries (Kafka redelivery)", async () => {
    await createWallet(TEST_USER_ID);
    const eventId = "evt_payment_100x_1";
    const payload = { userId: TEST_USER_ID, paymentId: "pay_100x_1", orderId: "order_100x_1", amount: 50, currency: "INR", description: "100x duplicate test" };

    const processingPromises = [];
    for (let i = 0; i < 100; i++) {
      processingPromises.push(processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload }).catch(() => {}));
    }

    await Promise.all(processingPromises);

    const transactions = await prisma.walletTransaction.findMany({ where: { eventId } });
    expect(transactions.length).toBe(1);

    const wallet = await getWallet(TEST_USER_ID);
    expect(parseFloat(wallet.balance)).toBe(50);
  });

  it("should fail gracefully when wallet does not exist", async () => {
    const eventId = "evt_no_wallet_1";
    const payload = { userId: "non_existent_user", paymentId: "pay_1", orderId: "order_1", amount: 100, currency: "INR", description: "No wallet" };

    await expect(processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload })).rejects.toThrow();
  });

  it("should achieve exactly-once wallet credit despite duplicate events", async () => {
    await createWallet(TEST_USER_ID);
    const eventId = "evt_exactly_once_1";
    const payload = { userId: TEST_USER_ID, paymentId: "pay_exact_1", orderId: "order_exact_1", amount: 333, currency: "INR", description: "Exactly-once proof" };

    await createEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload });

    // Process multiple times
    await processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload });
    await processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload });
    await processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload });

    const transactions = await prisma.walletTransaction.findMany({ where: { eventId } });
    expect(transactions.length).toBe(1);

    const wallet = await getWallet(TEST_USER_ID);
    expect(parseFloat(wallet.balance)).toBe(333);
  });

  it("should handle malformed PAYMENT_SUCCESS payload", async () => {
    const eventId = "evt_malformed_1";
    await expect(processEvent({ eventId, eventType: "PAYMENT_SUCCESS", payload: { userId: undefined } })).rejects.toThrow();
  });
});