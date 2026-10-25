import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Global error handling middleware
 * Must be registered after all routes
 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Generate request ID for correlation
  const requestId = (req.headers["x-request-id"] as string) || "unknown";

  // Log the error (internal details)
  logger.error(`[Error] Request ${requestId}: ${err.message}`, {
    requestId,
    path: req.path,
    method: req.method,
    error: err.stack,
  });

  // Handle known application errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Handle Prisma errors
  if (err.name === "PrismaClientKnownRequestError") {
    const prismaError = err as any;

    if (prismaError.code === "P2002") {
      // Unique constraint violation
      res.status(409).json({
        success: false,
        error: {
          code: "DUPLICATE_RESOURCE",
          message: "Resource already exists",
        },
      });
      return;
    }

    if (prismaError.code === "P2025") {
      // Record not found
      res.status(404).json({
        success: false,
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource not found",
        },
      });
      return;
    }
  }

  // Handle validation errors
  if (err.name === "ValidationError") {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: err.message,
      },
    });
    return;
  }

  // Default to 500 for unknown errors
  // Never expose internal error details in production
  const isDevelopment = process.env.NODE_ENV === "development";

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: isDevelopment
        ? err.message
        : "An unexpected error occurred. Please try again later.",
    },
  });
}

/**
 * Async route handler wrapper to catch errors
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}