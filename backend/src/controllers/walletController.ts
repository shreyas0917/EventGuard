import { Request, Response } from "express";
import { createWallet, getWallet, getWalletTransactions } from "../services/walletService.js";
import { logger } from "../lib/logger.js";
import { resolveTargetUser } from "../middleware/auth.js";

export async function handleCreateWallet(req: Request, res: Response): Promise<void> {
  try {
    const userId = resolveTargetUser(req, res, req.body.userId);
    if (!userId) return;

    const wallet = await createWallet(userId);

    res.status(201).json({
      success: true,
      wallet: {
        id: wallet.id,
        userId: wallet.userId,
        balance: parseFloat(wallet.balance),
        createdAt: wallet.createdAt,
      },
    });
  } catch (error) {
    logger.error("[Controller] Error creating wallet", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create wallet",
    });
  }
}

export async function handleGetWallet(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const wallet = await getWallet(userId);

    if (!wallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    res.json({
      success: true,
      wallet: {
        id: wallet.id,
        userId: wallet.userId,
        balance: parseFloat(wallet.balance),
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      },
    });
  } catch (error) {
    logger.error("[Controller] Error getting wallet", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get wallet",
    });
  }
}

export async function handleGetWalletTransactions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { userId } = req.params;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const transactions = await getWalletTransactions(userId);

    res.json({
      success: true,
      transactions: transactions.map((t) => ({
        id: t.id,
        eventId: t.eventId,
        type: t.type,
        amount: parseFloat(t.amount),
        reason: t.reason,
        status: t.status,
        createdAt: t.createdAt,
      })),
      total: transactions.length,
    });
  } catch (error) {
    logger.error("[Controller] Error getting wallet transactions", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get transactions",
    });
  }
}
