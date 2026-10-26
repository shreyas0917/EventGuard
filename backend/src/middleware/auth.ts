import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { verifyToken, Role } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

function sendAuthError(res: Response, status: 401 | 403, code: string, message: string): void {
  if (status === 401) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="eventguard"');
  }
  res.status(status).json({ success: false, error: { code, message } });
}

/**
 * Require a valid `Authorization: Bearer <jwt>` header and attach `req.auth`.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ") || header.length <= "Bearer ".length) {
    sendAuthError(res, 401, "UNAUTHENTICATED", "A bearer token is required");
    return;
  }

  try {
    req.auth = verifyToken(header.slice("Bearer ".length).trim());
    next();
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    logger.warn("[Auth] Rejected bearer token", {
      requestId: (req as any).requestId,
      path: req.path,
      reason: expired ? "expired" : error instanceof Error ? error.message : "invalid",
    });
    sendAuthError(
      res,
      401,
      expired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
      expired ? "The bearer token has expired" : "The bearer token is invalid"
    );
  }
}

/** Allow the request only if the authenticated role is one of `roles`. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      sendAuthError(res, 401, "UNAUTHENTICATED", "A bearer token is required");
      return;
    }

    if (!roles.includes(req.auth.role)) {
      logger.warn("[Auth] Role not permitted", {
        requestId: (req as any).requestId,
        path: req.path,
        userId: req.auth.userId,
        role: req.auth.role,
      });
      sendAuthError(res, 403, "FORBIDDEN", "You do not have permission to perform this action");
      return;
    }

    next();
  };
}

/**
 * Allow admins, or a user acting on their own resource identified by `req.params[param]`.
 */
export function requireSelfOrAdmin(param: string = "userId") {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      sendAuthError(res, 401, "UNAUTHENTICATED", "A bearer token is required");
      return;
    }

    if (req.auth.role === "admin" || req.auth.userId === req.params[param]) {
      next();
      return;
    }

    logger.warn("[Auth] Cross-user access denied", {
      requestId: (req as any).requestId,
      path: req.path,
      userId: req.auth.userId,
    });
    sendAuthError(res, 403, "FORBIDDEN", "You can only access your own resources");
  };
}

/**
 * Resolve which user an action targets: users may only act on themselves,
 * admins may name any user. Returns null (after responding 403) on a mismatch.
 */
export function resolveTargetUser(req: Request, res: Response, requested?: string): string | null {
  const auth = req.auth!;

  if (!requested || requested === auth.userId) {
    return requested ?? auth.userId;
  }

  if (auth.role === "admin") {
    return requested;
  }

  logger.warn("[Auth] Attempt to act on another user", {
    requestId: (req as any).requestId,
    path: req.path,
    userId: auth.userId,
  });
  sendAuthError(res, 403, "FORBIDDEN", "You can only act on your own account");
  return null;
}
