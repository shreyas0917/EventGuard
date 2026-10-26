import jwt from "jsonwebtoken";

export const TEST_JWT_SECRET = process.env.JWT_SECRET as string;
export const TEST_ADMIN_KEY = process.env.ADMIN_API_KEY as string;

type Role = "user" | "admin";

/** A valid token, optionally with overridden claims or signing options. */
export function tokenFor(
  userId: string,
  role: Role | string = "user",
  opts: { secret?: string; algorithm?: jwt.Algorithm; expiresIn?: number; issuer?: string; audience?: string } = {}
): string {
  return jwt.sign({ role }, opts.secret ?? TEST_JWT_SECRET, {
    algorithm: opts.algorithm ?? "HS256",
    subject: userId,
    issuer: opts.issuer ?? "eventguard",
    audience: opts.audience ?? "eventguard-api",
    expiresIn: opts.expiresIn ?? 300,
  });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An unsigned token claiming admin: the classic `alg: none` attack. */
export function unsignedAdminToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
    sub: "attacker",
    role: "admin",
    iss: "eventguard",
    aud: "eventguard-api",
    iat: now,
    exp: now + 300,
  })}.`;
}

/** A real user token whose payload is rewritten to role=admin, keeping the old signature. */
export function tamperedToAdmin(token: string): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  return `${header}.${b64url({ ...claims, role: "admin" })}.${signature}`;
}
