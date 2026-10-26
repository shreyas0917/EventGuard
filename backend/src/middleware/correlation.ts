import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { logger, withLogContext } from "../lib/logger.js";
import { httpRequestDuration } from "../lib/metrics.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Correlation ID middleware.
 * Accepts a well-formed X-Request-ID from the caller (or generates one), echoes it back,
 * and attaches it to every log line written while the request is handled.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const requestId =
    typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();

  // Store in request for use in handlers
  (req as any).requestId = requestId;

  // Add to response headers
  res.setHeader("X-Request-ID", requestId);

  withLogContext({ requestId }, next);
}

/** Low-cardinality route label: the matched route pattern, never the raw path with ids. */
function routeLabel(req: Request): string {
  return req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || "unmatched";
}

/**
 * Request logging middleware: one structured line per request plus the HTTP latency metric.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = routeLabel(req);
    httpRequestDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
    logger.info("[API] request completed", {
      method: req.method,
      route,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(seconds * 1000),
      userId: req.auth?.userId,
    });
  });

  next();
}
