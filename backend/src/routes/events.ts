import { Router } from "express";
import {
  handleCreateEvent,
  handleGetAllEvents,
  handleGetEventByEventId,
  handleGetEventHistory,
} from "../controllers/eventController.js";

const router = Router();

router.post("/", handleCreateEvent);
router.get("/", handleGetAllEvents);
router.get("/:eventId", handleGetEventByEventId);
router.get("/:eventId/history", handleGetEventHistory);

export default router;
