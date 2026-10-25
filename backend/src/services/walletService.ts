import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export async function createWallet(userId: string): Promise<any> {
  try {
    const existing = await prisma.wallet.findUnique({
      where: { userId },
    });

    if (existing) {
      logger.info(`[Wallet] Wallet already exists for user: ${userId}`);
      return existing;
    }

    const wallet = await prisma.wallet.create({
      data: {
        userId,
        balance: 0,
      },
    });

    logger.info(`[Wallet] Created wallet for user: ${userId}`);
    return wallet;
  } catch (error) {
    logger.error(`[Wallet] Error creating wallet for ${userId}`, error);
    throw error;
  }
}

export async function getWallet(userId: string): Promise<any> {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
    });

    return wallet;
  } catch (error) {
    logger.error(`[Wallet] Error getting wallet for ${userId}`, error);
    throw error;
  }
}

export async function creditWallet(
  userId: string,
  amount: number,
  eventId: string,
  reason: string = "Payment received"
): Promise<any> {
  try {
    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Check if wallet exists
      const wallet = await tx.wallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        throw new Error(`Wallet not found for user: ${userId}`);
      }

      // Create wallet transaction with UNIQUE constraint on eventId
      const walletTransaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          eventId,
          type: "CREDIT",
          amount,
          reason,
          status: "COMPLETED",
        },
      });

      // Update wallet balance
      const updatedWallet = await tx.wallet.update({
        where: { userId },
        data: {
          balance: {
            increment: amount,
          },
        },
      });

      logger.info(
        `[Wallet] Credited ${amount} to user ${userId} for event ${eventId}`
      );

      return {
        wallet: updatedWallet,
        walletTransaction,
      };
    });

    return result;
  } catch (error) {
    logger.error(
      `[Wallet] Error crediting wallet for ${userId} on event ${eventId}`,
      error
    );
    throw error;
  }
}

export async function getWalletTransactionByEventId(eventId: string): Promise<any> {
  try {
    const transaction = await prisma.walletTransaction.findUnique({
      where: { eventId },
    });

    return transaction;
  } catch (error) {
    logger.error(`[Wallet] Error getting transaction for event ${eventId}`, error);
    throw error;
  }
}

export async function getWalletTransactions(userId: string): Promise<any[]> {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      return [];
    }

    const transactions = await prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return transactions;
  } catch (error) {
    logger.error(`[Wallet] Error getting transactions for ${userId}`, error);
    throw error;
  }
}
