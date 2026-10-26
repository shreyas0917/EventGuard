/**
 * Dashboard sessions. The API issues short-lived JWTs through demo login; the
 * dashboard can hold a user session (Payment Demo) and an admin session
 * (event processing tabs) at the same time. Tokens live in sessionStorage,
 * so they are dropped when the tab closes.
 */
import { useSyncExternalStore } from "react";
import { API_BASE, parseResponseJson } from "./api";

export type Role = "user" | "admin";

export interface Session {
  userId: string;
  role: Role;
  token: string;
  expiresAt: number;
}

const STORAGE_KEY = "eventguard.sessions";
const listeners = new Set<() => void>();
let sessions: Partial<Record<Role, Session>> = load();

function load(): Partial<Record<Role, Session>> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
    for (const role of ["user", "admin"] as Role[]) {
      if (stored[role] && stored[role].expiresAt <= Date.now()) delete stored[role];
    }
    return stored;
  } catch {
    return {};
  }
}

function commit(next: Partial<Record<Role, Session>>) {
  sessions = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage can be unavailable (private mode); sessions still work in memory.
  }
  listeners.forEach((listener) => listener());
}

export function getSession(role: Role): Session | undefined {
  const session = sessions[role];
  return session && session.expiresAt > Date.now() ? session : undefined;
}

export function authHeaders(role: Role): Record<string, string> {
  const session = getSession(role);
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

/** Returns an error message, or null on success. */
export async function signIn(role: Role, userId: string, adminKey?: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/demo-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(role === "admin" ? { userId, role, adminKey } : { userId, role }),
    });
    const data = await parseResponseJson(res);
    if (!res.ok) {
      return data?.error?.message || data?.error?.details?.[0]?.message || `Sign-in failed (HTTP ${res.status})`;
    }
    commit({
      ...sessions,
      [role]: { userId, role, token: data.token, expiresAt: Date.now() + data.expiresIn * 1000 },
    });
    return null;
  } catch {
    return "Could not reach the API";
  }
}

export function signOut(role: Role) {
  const next = { ...sessions };
  delete next[role];
  commit(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSession(role: Role): Session | undefined {
  return useSyncExternalStore(subscribe, () => sessions[role]);
}
