import { Request, Response } from "express";
import { createEvent, getEventByEventId, getAllEvents, getEventHistory } from "../services/eventService.js";
import { logger } from "../lib/logger.js";

export async function handleCreateEvent(req: Request, res: Response) {
  try {
    const { eventId, eventType, payload } = req.body;

    if (!eventId || typeof eventId !== "string" || eventId.trim() === "") {
      res.status(400).json({
        error: "Invalid event data",
        details: "eventId must be a non-empty string",
      });
      return;
    }

    if (!eventType || typeof eventType !== "string" || eventType.trim() === "") {
      res.status(400).json({
        error: "Invalid event data",
        details: "eventType must be a non-empty string",
      });
      return;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      res.status(400).json({
        error: "Invalid event data",
        details: "payload must be a JSON object",
      });
      return;
    }

    try {
      const event = await createEvent({
        eventId,
        eventType,
        payload,
      });

      res.status(201).json({
        message: "Event created",
        event,
      });
    } catch (error: unknown) {
      const err = error as any;
      if (err.code === "P2002") {
        res.status(409).json({
          error: "Event already exists",
          eventId,
        });
        return;
      }
      throw error;
    }
  } catch (error) {
    logger.error("Error creating event", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function handleGetAllEvents(req: Request, res: Response) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    if (page < 1 || limit < 1) {
      res.status(400).json({
        error: "Invalid pagination parameters",
      });
      return;
    }

    const result = await getAllEvents(page, limit);

    res.json(result);
  } catch (error) {
    logger.error("Error fetching events", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function handleGetEventByEventId(req: Request, res: Response) {
  try {
    const { eventId } = req.params;

    const event = await getEventByEventId(eventId);

    if (!event) {
      res.status(404).json({
        error: "Event not found",
      });
      return;
    }

    res.json(event);
  } catch (error) {
    logger.error("Error fetching event", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function handleGetEventHistory(req: Request, res: Response) {
  try {
    const { eventId } = req.params;

    const event = await getEventByEventId(eventId);

    if (!event) {
      res.status(404).json({
        error: "Event not found",
      });
      return;
    }

    const history = await getEventHistory(eventId);

    res.json({
      eventId,
      history,
    });
  } catch (error) {
    logger.error("Error fetching event history", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}
