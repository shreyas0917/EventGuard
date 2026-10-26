import { runReconciliation, ReconciliationReport } from "../services/reconciliationService.js";
import { logger } from "../lib/logger.js";

let timer: NodeJS.Timeout | null = null;
let lastReport: ReconciliationReport | null = null;

export function getLastReconciliationReport(): ReconciliationReport | null {
  return lastReport;
}

/** Periodically run the read-only reconciliation and log any discrepancy loudly. */
export function startReconciliationWorker(intervalMs: number): void {
  if (timer || intervalMs <= 0) return;

  const cycle = async () => {
    try {
      lastReport = await runReconciliation();
      if (lastReport.ok) {
        logger.info("[Reconciliation] Ledger, balances, events and outbox are consistent", {
          walletsChecked: lastReport.walletsChecked,
        });
      } else {
        logger.warn("[Reconciliation] Discrepancies found - needs review", {
          walletBalanceMismatches: lastReport.walletBalanceMismatches.length,
          completedPaymentsWithoutSingleCredit: lastReport.completedPaymentsWithoutSingleCredit.length,
          ledgerEntriesWithoutCompletedEvent: lastReport.ledgerEntriesWithoutCompletedEvent.length,
          eventsWithoutOutbox: lastReport.eventsWithoutOutbox.length,
        });
      }
    } catch (error) {
      logger.error("[Reconciliation] Run failed", error);
    }
    timer = setTimeout(cycle, intervalMs);
  };

  timer = setTimeout(cycle, 5_000);
}

export function stopReconciliationWorker(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
