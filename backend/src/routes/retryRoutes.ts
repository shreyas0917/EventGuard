import { Router, Request, Response } from "express";
import {
  getFailedEvents,
  getRetryingEvents,
  resetEventForRetry,
} from "../services/eventClaimService.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

// GET /api/events/failed
// List all failed events
router.get("/failed", async (req: Request, res: Response): Promise<void> => {
  try {
    const failedEvents = await getFailedEvents();

    res.json({
      success: true,
      total: failedEvents.length,
      events: failedEvents.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        attemptCount: event.attemptCount,
        lastError: event.lastError,
        createdAt: event.createdAt,
      })),
    });
  } catch (error) {
    logger.error("[Events API] Error fetching failed events", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch failed events",
    });
  }
});

// GET /api/events/retrying
// List all retrying events
router.get("/retrying", async (req: Request, res: Response): Promise<void> => {
  try {
    const retryingEvents = await getRetryingEvents();

    res.json({
      success: true,
      total: retryingEvents.length,
      events: retryingEvents.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        attemptCount: event.attemptCount,
        nextRetryAt: event.nextRetryAt,
        lastError: event.lastError,
      })),
    });
  } catch (error) {
    logger.error("[Events API] Error fetching retrying events", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch retrying events",
    });
  }
});

// POST /api/events/:eventId/retry
// Manually retry a failed event
router.post("/:eventId/retry", async (req: Request, res: Response): Promise<void> => {
  try {
    const { eventId } = req.params;

    // Verify event exists
    const event = await prisma.event.findUnique({
      where: { eventId },
    });

    if (!event) {
      res.status(404).json({
        error: "Event not found",
      });
      return;
    }

    // Check if already completed (cannot retry completed events)
    if (event.status === "COMPLETED") {
      res.status(409).json({
        error: "Cannot retry completed event",
        status: event.status,
      });
      return;
    }

    // Check if already processing
    if (event.status === "PROCESSING") {
      res.status(409).json({
        error: "Cannot retry event that is currently processing",
        status: event.status,
      });
      return;
    }

    // Reset event for retry
    if (event.status !== "FAILED") {
      res.status(400).json({
        error: `Event is in ${event.status} status, only FAILED events can be manually retried`,
        status: event.status,
      });
      return;
    }

    // Reset the event for retry
    await resetEventForRetry(eventId);

    // Add audit log
    await prisma.eventLog.create({
      data: {
        eventId,
        status: "MANUAL_RETRY",
        message: "Manual retry initiated",
      },
    });

    logger.info(`[Events API] Manual retry initiated for event ${eventId}`);

    res.json({
      success: true,
      message: "Event scheduled for manual retry",
      eventId,
      status: "RETRYING",
    });
  } catch (error) {
    logger.error("[Events API] Error retrying event", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to retry event",
    });
  }
});

export default router;
