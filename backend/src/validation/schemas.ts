import { z } from "zod";

/** Identifiers: bounded length, no whitespace, slashes or control characters. */
export const identifier = (label: string) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .trim()
    .min(1, `${label} must not be empty`)
    .max(128, `${label} must be at most 128 characters`)
    .regex(/^[A-Za-z0-9_.:-]+$/, `${label} may only contain letters, digits, '_', '.', ':' and '-'`);

/** INR amount with at most two decimal places and a sane upper bound. */
export const inrAmount = z
  .number({ required_error: "amount is required", invalid_type_error: "amount must be a number" })
  .positive("amount must be greater than 0")
  .max(1_000_000, "amount must be at most 1,000,000 INR")
  .multipleOf(0.01, "amount may have at most two decimal places");

const pageQuery = z.coerce.number().int().min(1).max(10_000).default(1);
const limitQuery = z.coerce.number().int().min(1).max(100).default(20);

// ---------- Params ----------

export const userIdParams = z.object({ userId: identifier("userId") });
export const eventIdParams = z.object({ eventId: identifier("eventId") });
export const webhookIdParams = z.object({ id: z.string().uuid("id must be a UUID") });

// ---------- Queries ----------

export const paginationQuery = z.object({ page: pageQuery, limit: limitQuery });

export const dlqListQuery = z.object({
  status: z.enum(["PENDING", "REPLAYING", "RESOLVED"]).optional(),
});

export const webhookListQuery = z.object({
  status: z.enum(["RECEIVED", "PROCESSED", "IGNORED", "FAILED"]).optional(),
  limit: limitQuery,
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

// ---------- Bodies ----------

export const paymentSuccessPayload = z
  .object({
    userId: identifier("payload.userId"),
    paymentId: identifier("payload.paymentId"),
    orderId: identifier("payload.orderId"),
    amount: inrAmount,
    currency: z.literal("INR").optional(),
  })
  .strict();

export const createEventBody = z
  .object({
    eventId: identifier("eventId"),
    eventType: z
      .string({ required_error: "eventType is required" })
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "eventType must be UPPER_SNAKE_CASE"),
    payload: z.record(z.unknown(), { invalid_type_error: "payload must be a JSON object" }),
  })
  .strict()
  .superRefine((body, ctx) => {
    // PAYMENT_SUCCESS moves money, so its payload is held to an exact shape.
    if (body.eventType !== "PAYMENT_SUCCESS") return;
    const result = paymentSuccessPayload.safeParse(body.payload);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ["payload", ...issue.path] });
      }
    }
  });

export const createWalletBody = z.object({ userId: identifier("userId").optional() }).strict();

export const createOrderBody = z
  .object({
    amount: inrAmount,
    description: z.string().trim().min(1, "description is required").max(255),
    userId: identifier("userId").optional(),
  })
  .strict();

export const verifyPaymentBody = z
  .object({
    orderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/, "orderId must be a Razorpay order id"),
    paymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/, "paymentId must be a Razorpay payment id"),
    signature: z.string().regex(/^[a-f0-9]{64}$/, "signature must be a hex HMAC-SHA256 digest"),
    userId: identifier("userId").optional(),
  })
  .strict();

export const dlqResolveBody = z
  .object({ reason: z.string().trim().min(3, "reason must be at least 3 characters").max(500) })
  .strict();

export const demoLoginBody = z
  .object({
    userId: identifier("userId"),
    role: z.enum(["user", "admin"]).default("user"),
    adminKey: z.string().max(256).optional(),
  })
  .strict();
