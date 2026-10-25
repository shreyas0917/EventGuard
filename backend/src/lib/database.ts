import { Pool } from "pg";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let pool: Pool | null = null;

export async function connectDatabase() {
  try {
    pool = new Pool({
      connectionString: config.database_url,
    });

    await pool.query("SELECT NOW()");
    logger.info("Database connected successfully");
    return true;
  } catch (error) {
    logger.error("Database connection failed", error);
    return false;
  }
}

export function getDatabase() {
  if (!pool) {
    throw new Error("Database not connected");
  }
  return pool;
}

export async function closeDatabase() {
  if (pool) {
    await pool.end();
    logger.info("Database connection closed");
  }
}
