import { execFileSync, spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import {
  TEST_DATABASE_URL,
  TEST_KAFKA_BROKERS,
  TEST_REDIS_DB,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
} from "../setup/integration-config.js";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE_FILE = path.resolve(BACKEND_DIR, "../docker-compose.test.yml");

// Only ever the disposable test project; these helpers cannot reach the dev stack.
const PROJECT = "eventguard-test";
export type TestService = "postgres" | "redis" | "kafka";

function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Freeze a service: connections stay open but nothing answers (a hung dependency). */
export const pauseService = (service: TestService) => compose("pause", service);
export const unpauseService = (service: TestService) => compose("unpause", service);

/** Stop a service outright: connections are refused (a crashed dependency). */
export const stopService = (service: TestService) => compose("stop", service);

export async function startService(service: TestService, timeoutMs = 180_000): Promise<void> {
  compose("start", service);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = compose("ps", "--format", "{{.Health}}", service).trim();
    if (health === "healthy") return;
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy within ${timeoutMs} ms`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(250);
  }
  throw new Error(`${what} not met within ${timeoutMs} ms`);
}

export interface ConsumerProcess {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

/**
 * Run the real consumer entry point (src/eventConsumer.ts) as a separate OS process
 * against the test stack, so a test can kill it mid-flight like a crashed pod.
 */
export function spawnConsumer(env: Record<string, string>): ConsumerProcess {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/eventConsumer.ts"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_HOST: TEST_REDIS_HOST,
      REDIS_PORT: TEST_REDIS_PORT,
      REDIS_DB: TEST_REDIS_DB,
      KAFKA_BROKERS: TEST_KAFKA_BROKERS,
      JWT_SECRET: "vitest-only-jwt-secret-0123456789abcdef",
      AUTH_DEMO_LOGIN: "false",
      KAFKA_FROM_BEGINNING: "true",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (output += d.toString()));
  child.stderr?.on("data", (d) => (output += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => output, exited };
}
