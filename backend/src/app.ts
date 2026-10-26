import express from "express";
import healthRouter from "./routes/healthRoutes.js";
import eventsRouter from "./routes/events.js";
import outboxRouter from "./routes/outbox.js";
import paymentsRouter from "./routes/payments.js";
import walletsRouter from "./routes/wallets.js";
import retryRouter from "./routes/retryRoutes.js";
import dlqRouter from "./routes/dlqRoutes.js";
import webhookRouter from "./routes/webhookRoutes.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { correlationId, requestLogger } from "./middleware/correlation.js";
import { corsMiddleware, securityHeaders } from "./middleware/security.js";
import { rateLimit, strictRateLimit, webhookRateLimit, authRateLimit } from "./middleware/rateLimiter.js";
import { authenticate, requireRole } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";

export function createApp() {
  const app = express();

  // Phase 10: Security headers
  app.use(securityHeaders());

  // Phase 10: CORS
  app.use(corsMiddleware());

  // Phase 10: Correlation ID for request tracking
  app.use(correlationId);

  // Phase 10: Request logging
  app.use(requestLogger);

  // Body parser — capture original raw bytes for Razorpay webhook HMAC verification
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        // Preserve exact request bytes before JSON parsing rewrites the representation
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    })
  );

  // Phase 10: General rate limiting for API
  app.use("/api", rateLimit());

  // Health endpoints (no rate limit, no auth)
  app.use("/health", healthRouter);

  // Access policy
  //   public:        /health, /api/auth/demo-login, GET /api/payments/config
  //   HMAC-signed:   POST /api/webhooks/razorpay
  //   any user:      own wallet, own payment orders and verification
  //   admin only:    events, retries, outbox, DLQ, webhook history
  app.use("/api/auth", authRateLimit, authRouter);

  // Mount retryRouter before eventsRouter so static paths (/failed, /retrying)
  // are not captured by GET /:eventId
  app.use("/api/events", authenticate, requireRole("admin"), retryRouter, eventsRouter);
  app.use("/api/outbox", authenticate, requireRole("admin"), outboxRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/wallets", authenticate, walletsRouter);

  // DLQ endpoints with strict rate limit (admin operations)
  app.use("/api/dlq", authenticate, requireRole("admin"), strictRateLimit, dlqRouter);

  // Webhook endpoint with custom rate limit
  app.use("/api/webhooks", webhookRateLimit, webhookRouter);

  app.get("/", (req, res) => {
    res.json({
      service: "eventguard-api",
      message: "Reliable events. Exactly-once business effects.",
      version: "1.0.0",
    });
  });

  // Phase 10: Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
