import { Request, Response } from "express";
import { createEvent, getEventByEventId, getAllEvents, getEventHistory } from "../services/eventService.js";
import { logger } from "../lib/logger.js";

export async function handleCreateEvent(req: Request, res: Response) {
  try {
    // Shape is enforced by createEventBody (PAYMENT_SUCCESS payloads are checked strictly)
    const { eventId, eventType, payload } = req.body;

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
    // Validated and bounded by paginationQuery (page >= 1, 1 <= limit <= 100)
    const { page, limit } = req.query as unknown as { page: number; limit: number };

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
