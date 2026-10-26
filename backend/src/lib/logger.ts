import { AsyncLocalStorage } from "async_hooks";

/**
 * Structured logger: one JSON object per line, enriched with the current request or
 * event context (requestId, eventId, ...) without passing it through every call.
 *
 *   {"ts":"...","level":"info","service":"eventguard-api","msg":"...","requestId":"..."}
 *
 * LOG_FORMAT=pretty prints the same records in a readable single-line form for local work.
 */

type Level = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

const contextStorage = new AsyncLocalStorage<LogContext>();
const SERVICE = process.env.SERVICE_NAME || "eventguard-api";
const PRETTY = process.env.LOG_FORMAT === "pretty";
const DEBUG_ENABLED = process.env.LOG_LEVEL === "debug" || process.env.NODE_ENV === "development";
const RESERVED = new Set(["ts", "level", "service", "msg"]);

/** Run `fn` with extra fields attached to every log line it (and its async work) emits. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return contextStorage.run({ ...contextStorage.getStore(), ...context }, fn);
}

export function getLogContext(): LogContext {
  return contextStorage.getStore() ?? {};
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { message: String(err) };
}

function write(level: Level, msg: string, extra?: unknown) {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    msg,
    ...contextStorage.getStore(),
  };

  if (extra instanceof Error || (level === "error" && extra !== undefined && typeof extra !== "object")) {
    record.err = serializeError(extra);
  } else if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      record[RESERVED.has(key) ? `data_${key}` : key] = value instanceof Error ? serializeError(value) : value;
    }
  } else if (extra !== undefined && extra !== "") {
    record.detail = extra;
  }

  let line: string;
  if (PRETTY) {
    const { ts, level: lvl, service, msg: message, ...rest } = record;
    line = `${ts} ${String(lvl).toUpperCase().padEnd(5)} ${message}${Object.keys(rest).length ? " " + JSON.stringify(rest) : ""}`;
  } else {
    line = JSON.stringify(record);
  }

  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg: string, data?: any) => write("info", msg, data),
  warn: (msg: string, data?: any) => write("warn", msg, data),
  error: (msg: string, err?: any) => write("error", msg, err),
  debug: (msg: string, data?: any) => {
    if (DEBUG_ENABLED) write("debug", msg, data);
  },
};
