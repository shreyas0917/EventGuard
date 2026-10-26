import { execSync } from "child_process";
import pg from "pg";
import { TEST_DATABASE_URL, assertDisposableTarget } from "./integration-config.js";

/**
 * Create the test database if needed and bring it to the current schema with
 * `prisma migrate deploy` (the same command production startup uses).
 */
export default async function setup(): Promise<void> {
  // Suites TRUNCATE tables and flush Redis: never let them near a real database
  assertDisposableTarget();

  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
    }
  } finally {
    await client.end();
  }

  execSync("npx prisma migrate deploy --schema=prisma/schema.prisma", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
