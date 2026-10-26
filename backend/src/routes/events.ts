import { Router } from "express";
import {
  handleCreateEvent,
  handleGetAllEvents,
  handleGetEventByEventId,
  handleGetEventHistory,
} from "../controllers/eventController.js";
import { validate } from "../middleware/validate.js";
import { createEventBody, eventIdParams, paginationQuery } from "../validation/schemas.js";

const router = Router();

// Admin-only (enforced where the router is mounted in app.ts)
router.post("/", validate({ body: createEventBody }), handleCreateEvent);
router.get("/", validate({ query: paginationQuery }), handleGetAllEvents);
router.get("/:eventId", validate({ params: eventIdParams }), handleGetEventByEventId);
router.get("/:eventId/history", validate({ params: eventIdParams }), handleGetEventHistory);

export default router;
