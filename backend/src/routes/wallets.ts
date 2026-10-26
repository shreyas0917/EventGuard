import { Router } from "express";
import {
  handleCreateWallet,
  handleGetWallet,
  handleGetWalletTransactions,
} from "../controllers/walletController.js";
import { requireSelfOrAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createWalletBody, userIdParams } from "../validation/schemas.js";

const router = Router();

// All wallet routes require authentication (enforced where the router is mounted in app.ts)

// POST /api/wallets
// Create the caller's wallet (admins may name another userId)
router.post("/", validate({ body: createWalletBody }), handleCreateWallet);

// GET /api/wallets/:userId
// Get wallet details - owner or admin only
router.get("/:userId", validate({ params: userIdParams }), requireSelfOrAdmin("userId"), handleGetWallet);

// GET /api/wallets/:userId/transactions
// Get wallet transaction history - owner or admin only
router.get(
  "/:userId/transactions",
  validate({ params: userIdParams }),
  requireSelfOrAdmin("userId"),
  handleGetWalletTransactions
);

export default router;
