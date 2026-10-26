/**
 * Connection settings for integration suites. Defaults point at the disposable stack in
 * docker-compose.test.yml (Compose project "eventguard-test"); override with environment
 * variables, e.g. in CI.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://eventguard:eventguard@localhost:55432/eventguard_test?connection_limit=25&pool_timeout=30";

export const TEST_REDIS_HOST = process.env.TEST_REDIS_HOST || "localhost";
export const TEST_REDIS_PORT = process.env.TEST_REDIS_PORT || "56379";
export const TEST_REDIS_DB = process.env.TEST_REDIS_DB || "0";
export const TEST_KAFKA_BROKERS = process.env.TEST_KAFKA_BROKERS || "localhost:59092";

/** Guard against pointing the destructive test helpers (TRUNCATE, FLUSHDB) at real data. */
export function assertDisposableTarget(): void {
  const url = new URL(TEST_DATABASE_URL);
  if (!url.pathname.endsWith("_test")) {
    throw new Error(`Refusing to run integration tests against "${url.pathname.slice(1)}": the database name must end in _test`);
  }
}
