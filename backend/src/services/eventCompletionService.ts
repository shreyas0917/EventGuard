import { prisma, TX_OPTIONS } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { creditWalletInTx } from "./walletService.js";
import { walletCreditAmount, walletCredits } from "../lib/metrics.js";

export interface ClaimedEvent {
  eventId: string;
  eventType: string;
  payload: any;
}

interface PaymentCredit {
  userId: string;
  amount: number;
}

function parsePaymentPayload(eventId: string, payload: any): PaymentCredit {
  const { userId, paymentId, orderId, amount } = payload ?? {};
  if (!userId || !paymentId || !orderId || !amount) {
    throw new Error(`Invalid PAYMENT_SUCCESS payload for ${eventId}`);
  }
  return { userId, amount };
}

/**
 * Apply an event's business effect and mark it COMPLETED in ONE transaction,
 * fenced by the claim token.
 *
 * The first statement is a conditional UPDATE on the event row: it only matches
 * while this worker still owns the claim, and it holds the row lock until commit,
 * so a worker whose lease was taken over cannot write anything. Because the credit
 * and the status change commit together, a crash leaves either both or neither:
 * there is no "credited but not completed" window to recover from.
 *
 * Statement order matters for throughput: the wallet balance UPDATE is the only
 * statement that waits on a potentially hot row lock (many events, one wallet),
 * so it runs last and the lock is held only until COMMIT.
 *
 * Returns { completed: false } if the claim was lost (nothing was written), otherwise
 * the event's creation time, for end-to-end latency.
 */
export type CompletionResult = { completed: true; createdAt: Date } | { completed: false };

export async function completeEvent(event: ClaimedEvent, claimToken: string): Promise<CompletionResult> {
  const { eventId } = event;
  const credit = event.eventType === "PAYMENT_SUCCESS" ? parsePaymentPayload(eventId, event.payload) : null;

  let credited = false;
  const result = await prisma.$transaction(async (tx): Promise<CompletionResult> => {
    const fenced = await tx.event.updateMany({
      where: { eventId, status: "PROCESSING", claimToken },
      data: {
        status: "COMPLETED",
        processedAt: new Date(),
        claimToken: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });

    if (fenced.count !== 1) {
      return { completed: false };
    }

    const { createdAt } = await tx.event.findUniqueOrThrow({ where: { eventId }, select: { createdAt: true } });

    // We hold the event row lock, so only this transaction can be crediting this eventId.
    // An existing ledger row means an earlier attempt already paid; the UNIQUE constraint
    // on wallet_transactions.eventId remains the backstop if this check is ever bypassed.
    const alreadyCredited = credit ? (await tx.walletTransaction.findUnique({ where: { eventId } })) !== null : false;

    const logs: Array<{ eventId: string; status: string; message: string }> = [];
    if (credit && alreadyCredited) {
      logs.push({ eventId, status: "DUPLICATE", message: "Ledger entry already exists - credit skipped" });
      logger.info(`[Worker] Credit for ${eventId} already in ledger - skipped`);
    } else if (credit) {
      logs.push({ eventId, status: "WALLET_CREDITED", message: `Wallet credited: ${credit.amount}` });
    }
    logs.push({ eventId, status: "COMPLETED", message: "Event processing completed" });
    await tx.eventLog.createMany({ data: logs });

    // A completed event has nothing left to dead-letter (e.g. a manual retry succeeded)
    await tx.deadLetterEvent.updateMany({
      where: { eventId, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED" },
    });

    // Last: ledger insert + atomic balance increment
    if (credit && !alreadyCredited) {
      await creditWalletInTx(tx, credit.userId, credit.amount, eventId, "Payment received");
      credited = true;
    }

    return { completed: true, createdAt };
  }, TX_OPTIONS);

  // Counted only after the transaction committed
  if (credited && credit) {
    walletCredits.inc();
    walletCreditAmount.inc(Number(credit.amount));
  }
  return result;
}
