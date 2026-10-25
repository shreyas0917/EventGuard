import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";

/**
 * Correlation ID middleware
 * Adds X-Request-ID to each request for distributed tracing
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  // Use existing request ID if provided, otherwise generate new one
  const requestId = (req.headers["x-request-id"] as string) || randomUUID();

  // Store in request for use in handlers
  (req as any).requestId = requestId;

  // Add to response headers
  res.setHeader("X-Request-ID", requestId);

  next();
}

/**
 * Request logging middleware
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req as any).requestId;
  const start = Date.now();

  // Log request
  logger.info(`[API] ${req.method} ${req.path}`, {
    requestId,
    method: req.method,
    path: req.path,
  });

  // Log response when finished
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`[API] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
    });
  });

  next();
}