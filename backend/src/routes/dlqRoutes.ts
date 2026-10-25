import { Router } from "express";
import {
  getDLQEvents,
  getDLQEvent,
  startReplay,
  completeReplay,
  failReplay,
  resolveDLQManually,
} from "../services/dlqService.js";
import { processEventById } from "../services/eventProcessingService.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const router = Router();

// GET /api/dlq - List all DLQ events
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const events = await getDLQEvents(status as string | undefined);

    res.json({
      success: true,
      count: events.length,
      data: events,
    });
  } catch (error) {
    logger.error("[DLQ Routes] Error fetching DLQ events", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch DLQ events",
    });
  }
});

// GET /api/dlq/:eventId - Get DLQ event details
router.get("/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;

    const dlqEvent = await getDLQEvent(eventId);

    if (!dlqEvent) {
      return res.status(404).json({
        success: false,
        error: "DLQ event not found",
      });
    }

    // Also fetch the original event and event logs for context
    const [originalEvent, eventLogs] = await Promise.all([
      prisma.event.findUnique({
        where: { eventId },
        include: { logs: { orderBy: { createdAt: "desc" }, take: 50 } },
      }),
      prisma.eventLog.findMany({
        where: { eventId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    res.json({
      success: true,
      data: {
        ...dlqEvent,
        originalEvent,
        eventLogs,
      },
    });
  } catch (error) {
    logger.error(`[DLQ Routes] Error fetching DLQ event ${req.params.eventId}`, error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch DLQ event",
    });
  }
});

// POST /api/dlq/:eventId/replay - Replay event from DLQ
router.post("/:eventId/replay", async (req, res) => {
  try {
    const { eventId } = req.params;

    const dlqEvent = await getDLQEvent(eventId);

    if (!dlqEvent) {
      return res.status(404).json({
        success: false,
        error: "DLQ event not found",
      });
    }

    if (dlqEvent.status === "RESOLVED") {
      return res.status(409).json({
        success: false,
        error: "Event already resolved",
      });
    }

    if (dlqEvent.status === "REPLAYING") {
      return res.status(409).json({
        success: false,
        error: "Replay already in progress",
      });
    }

    // Start replay - mark as REPLAYING
    await startReplay(eventId);

    try {
      // Replay the event using existing processEvent function
      // This preserves idempotency - the original eventId is used
      const result = await processEventById(eventId, dlqEvent.eventType, dlqEvent.payload);

      if (result.success) {
        // Replay succeeded - mark as RESOLVED
        await completeReplay(eventId);

        logger.info(`[DLQ Routes] Replay succeeded for event ${eventId}`);

        return res.json({
          success: true,
          message: "Event replayed successfully",
          data: result,
        });
      } else {
        // Replay failed - mark back to PENDING with new reason
        await failReplay(eventId, result.error || "Replay failed");

        logger.error(`[DLQ Routes] Replay failed for event ${eventId}`, result.error);

        return res.status(500).json({
          success: false,
          error: "Replay failed",
          details: result.error,
        });
      }
    } catch (replayError) {
      // Replay threw an exception - mark back to PENDING
      const errorMessage = replayError instanceof Error ? replayError.message : "Unknown error";
      await failReplay(eventId, errorMessage);

      logger.error(`[DLQ Routes] Replay exception for event ${eventId}`, replayError);

      return res.status(500).json({
        success: false,
        error: "Replay failed with exception",
        details: errorMessage,
      });
    }
  } catch (error) {
    logger.error(`[DLQ Routes] Error replaying DLQ event ${req.params.eventId}`, error);
    res.status(500).json({
      success: false,
      error: "Failed to replay event",
    });
  }
});

// POST /api/dlq/:eventId/resolve - Manual resolve without replay
router.post("/:eventId/resolve", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        error: "Resolution reason is required",
      });
    }

    const dlqEvent = await getDLQEvent(eventId);

    if (!dlqEvent) {
      return res.status(404).json({
        success: false,
        error: "DLQ event not found",
      });
    }

    if (dlqEvent.status === "RESOLVED") {
      return res.status(409).json({
        success: false,
        error: "Event already resolved",
      });
    }

    // Manual resolve - no business effect, just mark as resolved
    await resolveDLQManually(eventId, reason);

    logger.info(`[DLQ Routes] Event ${eventId} manually resolved: ${reason}`);

    res.json({
      success: true,
      message: "Event manually resolved",
      data: {
        eventId,
        reason,
      },
    });
  } catch (error) {
    logger.error(`[DLQ Routes] Error resolving DLQ event ${req.params.eventId}`, error);
    res.status(500).json({
      success: false,
      error: "Failed to resolve event",
    });
  }
});

// GET /api/dlq/stats - Get DLQ statistics
router.get("/stats/summary", async (req, res) => {
  try {
    const [pending, replaying, resolved, total] = await Promise.all([
      prisma.deadLetterEvent.count({ where: { status: "PENDING" } }),
      prisma.deadLetterEvent.count({ where: { status: "REPLAYING" } }),
      prisma.deadLetterEvent.count({ where: { status: "RESOLVED" } }),
      prisma.deadLetterEvent.count(),
    ]);

    res.json({
      success: true,
      data: {
        pending,
        replaying,
        resolved,
        total,
      },
    });
  } catch (error) {
    logger.error("[DLQ Routes] Error fetching DLQ stats", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch DLQ stats",
    });
  }
});

export default router;