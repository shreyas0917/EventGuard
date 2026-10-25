import { Request, Response } from "express";
import {
  getOutboxEventByEventId,
  getAllOutboxEvents,
} from "../services/eventService.js";
import { logger } from "../lib/logger.js";

export async function handleGetAllOutboxEvents(req: Request, res: Response) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    if (page < 1 || limit < 1) {
      res.status(400).json({
        error: "Invalid pagination parameters",
      });
      return;
    }

    const result = await getAllOutboxEvents(page, limit);

    res.json(result);
  } catch (error) {
    logger.error("Error fetching outbox events", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function handleGetOutboxEventByEventId(
  req: Request,
  res: Response
) {
  try {
    const { eventId } = req.params;

    const outboxEvent = await getOutboxEventByEventId(eventId);

    if (!outboxEvent) {
      res.status(404).json({
        error: "Outbox event not found",
      });
      return;
    }

    res.json(outboxEvent);
  } catch (error) {
    logger.error("Error fetching outbox event", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}
