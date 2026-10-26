import { Router, Request, Response } from "express";
import { config } from "../config/index.js";
import { issueToken, safeEqual } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { demoLoginBody } from "../validation/schemas.js";

const router = Router();

/**
 * POST /api/auth/demo-login
 *
 * Issues a JWT without a user store, for the local dashboard and demos.
 * Disabled unless AUTH_DEMO_LOGIN=true (startup refuses it in production).
 * An admin token additionally requires the ADMIN_API_KEY shared secret.
 */
router.post("/demo-login", validate({ body: demoLoginBody }), (req: Request, res: Response): void => {
  if (!config.auth_demo_login_enabled) {
    res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    return;
  }

  const { userId, role, adminKey } = req.body as { userId: string; role: "user" | "admin"; adminKey?: string };

  if (role === "admin") {
    if (!config.admin_api_key || !adminKey || !safeEqual(adminKey, config.admin_api_key)) {
      logger.warn("[Auth] Admin demo login rejected", { requestId: (req as any).requestId, userId });
      res.status(401).json({
        success: false,
        error: { code: "INVALID_ADMIN_KEY", message: "A valid admin key is required for an admin token" },
      });
      return;
    }
  }

  const { token, expiresIn } = issueToken({ userId, role });
  logger.info("[Auth] Demo token issued", { requestId: (req as any).requestId, userId, role });

  res.json({
    success: true,
    tokenType: "Bearer",
    token,
    expiresIn,
    user: { userId, role },
  });
});

// GET /api/auth/me - Who does this token belong to?
router.get("/me", authenticate, (req: Request, res: Response): void => {
  res.json({ success: true, user: req.auth });
});

export default router;
