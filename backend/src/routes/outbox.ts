import { Router } from "express";
import {
  handleGetAllOutboxEvents,
  handleGetOutboxEventByEventId,
} from "../controllers/outboxController.js";

const router = Router();

router.get("/", handleGetAllOutboxEvents);
router.get("/:eventId", handleGetOutboxEventByEventId);

export default router;
