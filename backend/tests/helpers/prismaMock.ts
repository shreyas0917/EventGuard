import { vi, type Mock } from "vitest";

/**
 * In-memory stand-in for PrismaClient so the HTTP layer can be tested without a
 * database. Every model method is a stable vi.fn (override per test with
 * mockResolvedValueOnce); defaults model an empty database.
 */
const defaults: Record<string, (args?: any) => unknown> = {
  findMany: () => [],
  findUnique: () => null,
  findFirst: () => null,
  count: () => 0,
  create: (args) => ({ id: "00000000-0000-4000-8000-000000000000", createdAt: new Date(), ...args?.data }),
  update: (args) => ({ ...args?.data }),
  upsert: (args) => ({ ...args?.create }),
  delete: () => ({}),
  updateMany: () => ({ count: 0 }),
  deleteMany: () => ({ count: 0 }),
};

const models = new Map<string, Record<string, Mock>>();

function model(name: string): Record<string, Mock> {
  let m = models.get(name);
  if (!m) {
    const fns: Record<string, Mock> = {};
    m = new Proxy(fns, {
      get(target, method: string) {
        if (!target[method]) {
          const impl = defaults[method] ?? (() => ({}));
          target[method] = vi.fn(async (args?: any) => impl(args));
        }
        return target[method];
      },
    });
    models.set(name, m);
  }
  return m;
}

export const prisma: any = new Proxy(
  {},
  {
    get(_target, prop: string | symbol) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "$transaction") {
        return async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg));
      }
      if (prop === "$executeRaw" || prop === "$executeRawUnsafe") return async () => 0;
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe") return async () => [];
      if (prop === "$connect" || prop === "$disconnect") return async () => {};
      return model(prop);
    },
  }
);

// Mirrors src/lib/prisma.ts so modules importing the transaction budget load against the mock
export const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export function resetPrismaMock(): void {
  models.clear();
}
