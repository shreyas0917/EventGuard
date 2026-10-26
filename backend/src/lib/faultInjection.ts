import { logger } from "./logger.js";

/**
 * Test-only crash points for failure-injection suites, e.g.
 *   FAULT_INJECTION=crash-after-commit:evt_123
 * kills the process right after the business effect for evt_123 commits but before
 * the Kafka offset is committed: the exact window that at-least-once delivery creates.
 * Startup validation refuses FAULT_INJECTION in production.
 */
export type CrashPoint = "crash-before-commit" | "crash-after-commit";

export function maybeCrash(point: CrashPoint, eventId: string): void {
  const spec = process.env.FAULT_INJECTION;
  if (!spec) return;

  const separator = spec.indexOf(":");
  if (spec.slice(0, separator) === point && spec.slice(separator + 1) === eventId) {
    logger.warn(`[FaultInjection] ${point} for ${eventId}: exiting with 137`);
    process.exit(137);
  }
}
