import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

export type Role = "user" | "admin";

export interface AuthContext {
  userId: string;
  role: Role;
}

const ROLES: readonly Role[] = ["user", "admin"];

export function issueToken(ctx: AuthContext): { token: string; expiresIn: number } {
  const token = jwt.sign({ role: ctx.role }, config.jwt_secret, {
    algorithm: "HS256",
    subject: ctx.userId,
    issuer: config.jwt_issuer,
    audience: config.jwt_audience,
    expiresIn: config.jwt_ttl_seconds,
  });
  return { token, expiresIn: config.jwt_ttl_seconds };
}

/**
 * Verify signature, algorithm, issuer, audience and expiry, then check the claims.
 * Pinning algorithms to HS256 rejects `alg: none` and algorithm-confusion tokens.
 */
export function verifyToken(token: string): AuthContext {
  const claims = jwt.verify(token, config.jwt_secret, {
    algorithms: ["HS256"],
    issuer: config.jwt_issuer,
    audience: config.jwt_audience,
  });

  if (typeof claims === "string" || !claims.sub || !ROLES.includes(claims.role)) {
    throw new jwt.JsonWebTokenError("token is missing a subject or a valid role");
  }

  return { userId: claims.sub, role: claims.role as Role };
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a).digest();
  const digestB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}
