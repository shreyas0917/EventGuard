import { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "../config/index.js";

/**
 * CORS configuration
 */
export function corsMiddleware() {
  const allowedOrigins = config.cors_origin.split(",").map((origin) => origin.trim());

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      // In development, allow localhost
      if (config.node_env === "development") {
        if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
          callback(null, true);
          return;
        }
      }

      // Check against allowed origins
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "X-Razorpay-Signature"],
    exposedHeaders: ["X-Request-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  });
}

/**
 * Security headers middleware using Helmet
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    xssFilter: true,
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
  });
}

/**
 * Request body size limit middleware
 */
export function bodyLimit(limit: string = "1mb") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    const limitBytes = parseSize(limit);

    if (contentLength > limitBytes) {
      res.status(413).json({
        success: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `Request body exceeds ${limit} limit`,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Parse size string to bytes
 */
function parseSize(size: string): number {
  const units: { [key: string]: number } = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/);
  if (!match) {
    return 1024 * 1024; // Default 1MB
  }

  const value = parseFloat(match[1]);
  const unit = match[2] || "b";

  return Math.floor(value * (units[unit] || 1));
}