import { Router } from "express";
import {
  handleGetAllOutboxEvents,
  handleGetOutboxEventByEventId,
} from "../controllers/outboxController.js";
import { validate } from "../middleware/validate.js";
import { eventIdParams, paginationQuery } from "../validation/schemas.js";

const router = Router();

// Admin-only (enforced where the router is mounted in app.ts)
router.get("/", validate({ query: paginationQuery }), handleGetAllOutboxEvents);
router.get("/:eventId", validate({ params: eventIdParams }), handleGetOutboxEventByEventId);

export default router;
