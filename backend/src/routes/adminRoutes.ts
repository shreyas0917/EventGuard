import { Router, Request, Response } from "express";
import { runReconciliation } from "../services/reconciliationService.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Admin-only (enforced where the router is mounted in app.ts)

// GET /api/admin/reconciliation - Cross-check balances, ledger, events and outbox (read-only)
router.get("/reconciliation", async (req: Request, res: Response): Promise<void> => {
  try {
    const report = await runReconciliation();
    res.json({ success: true, data: report });
  } catch (error) {
    logger.error("[Admin] Reconciliation failed", error);
    res.status(500).json({ success: false, error: "Reconciliation failed" });
  }
});

export default router;
