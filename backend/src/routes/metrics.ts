import { Request, Response } from "express";
import { registry } from "../lib/metrics.js";
import { safeEqual } from "../lib/auth.js";

/**
 * GET /metrics in Prometheus text format. Meant for an internal scrape; when
 * METRICS_TOKEN is set, the scraper must send it as a bearer token.
 */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), token)) {
      res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Metrics token required" } });
      return;
    }
  }

  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
}
