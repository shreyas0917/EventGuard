import { useState, FormEvent } from "react";
import { Role, signIn, signOut, useSession } from "../config/auth";

function SessionForm({ role }: { role: Role }) {
  const session = useSession(role);
  const [userId, setUserId] = useState(role === "admin" ? "ops-admin" : "user-123");
  const [adminKey, setAdminKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const label = role === "admin" ? "Admin" : "User";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await signIn(role, userId.trim(), role === "admin" ? adminKey : undefined));
    setAdminKey("");
    setBusy(false);
  };

  if (session) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-xs uppercase tracking-wider text-text-secondary">{label}</span>
        <span className="font-mono text-text-primary">{session.userId}</span>
        <button
          type="button"
          onClick={() => signOut(role)}
          className="px-3 py-1.5 border border-dark-border rounded-md text-text-secondary hover:text-text-primary hover:border-accent-gold transition-colors"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs uppercase tracking-wider text-text-secondary w-12">{label}</span>
      <label className="sr-only" htmlFor={`${role}-userId`}>{label} user ID</label>
      <input
        id={`${role}-userId`}
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="w-32 px-2 py-1.5 bg-dark-bg border border-dark-border rounded-md text-text-primary font-mono focus:outline-none focus:border-accent-gold"
        required
      />
      {role === "admin" && (
        <>
          <label className="sr-only" htmlFor="admin-key">Admin key</label>
          <input
            id="admin-key"
            type="password"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="Admin key"
            autoComplete="off"
            className="w-36 px-2 py-1.5 bg-dark-bg border border-dark-border rounded-md text-text-primary focus:outline-none focus:border-accent-gold"
            required
          />
        </>
      )}
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 bg-accent-gold text-dark-bg font-medium rounded-md hover:bg-accent-muted disabled:opacity-50 transition-colors"
      >
        {busy ? "Signing in..." : "Sign in"}
      </button>
      {error && <span className="basis-full text-xs text-red-400 pl-14">{error}</span>}
    </form>
  );
}

export function AuthPanel() {
  return (
    <div className="flex flex-col gap-2">
      <SessionForm role="user" />
      <SessionForm role="admin" />
    </div>
  );
}

export function SignInNotice({ role, purpose }: { role: Role; purpose: string }) {
  return (
    <div className="card text-sm text-text-secondary">
      <span className="text-text-primary font-medium">
        {role === "admin" ? "Admin sign-in required." : "User sign-in required."}
      </span>{" "}
      {purpose} Use the {role === "admin" ? "Admin" : "User"} sign-in at the top of the page.
    </div>
  );
}
