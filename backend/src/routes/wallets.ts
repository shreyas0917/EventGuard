import { Router } from "express";
import {
  handleCreateWallet,
  handleGetWallet,
  handleGetWalletTransactions,
} from "../controllers/walletController.js";

const router = Router();

// POST /api/wallets
// Create a new wallet for a user
router.post("/", handleCreateWallet);

// GET /api/wallets/:userId
// Get wallet details
router.get("/:userId", handleGetWallet);

// GET /api/wallets/:userId/transactions
// Get wallet transaction history
router.get("/:userId/transactions", handleGetWalletTransactions);

export default router;
