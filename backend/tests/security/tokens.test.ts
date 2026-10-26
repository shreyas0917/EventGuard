import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { bearer, tokenFor, tamperedToAdmin, unsignedAdminToken, TEST_ADMIN_KEY } from "../helpers/tokens.js";

vi.mock("../../src/lib/prisma.js", async () => await import("../helpers/prismaMock.js"));

const { createApp } = await import("../../src/app.js");
const { config } = await import("../../src/config/index.js");

const app = createApp();
const ADMIN_ONLY = "/api/dlq/stats/summary";

describe("bearer token verification", () => {
  const rejected: Array<[name: string, header: string, code: string]> = [
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz", "UNAUTHENTICATED"],
    ["an empty Bearer value", "Bearer ", "UNAUTHENTICATED"],
    ["a malformed token", "Bearer not.a.jwt", "INVALID_TOKEN"],
    ["a token signed with another secret", `Bearer ${tokenFor("ops", "admin", { secret: "attacker-secret-0123456789abcdefghij" })}`, "INVALID_TOKEN"],
    ["an unsigned alg:none token", `Bearer ${unsignedAdminToken()}`, "INVALID_TOKEN"],
    ["a token signed with HS512 instead of HS256", `Bearer ${tokenFor("ops", "admin", { algorithm: "HS512" })}`, "INVALID_TOKEN"],
    ["an expired token", `Bearer ${tokenFor("ops", "admin", { expiresIn: -10 })}`, "TOKEN_EXPIRED"],
    ["a token for another audience", `Bearer ${tokenFor("ops", "admin", { audience: "some-other-api" })}`, "INVALID_TOKEN"],
    ["a token from another issuer", `Bearer ${tokenFor("ops", "admin", { issuer: "evil-idp" })}`, "INVALID_TOKEN"],
    ["a token with an unknown role", `Bearer ${tokenFor("ops", "superadmin")}`, "INVALID_TOKEN"],
    ["a user token edited to claim admin", `Bearer ${tamperedToAdmin(tokenFor("user_a", "user"))}`, "INVALID_TOKEN"],
  ];

  it.each(rejected)("rejects %s", async (_name, header, code) => {
    const res = await request(app).get(ADMIN_ONLY).set("Authorization", header);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(code);
  });

  it("rejects a token without a subject", async () => {
    const noSub = jwt.sign({ role: "admin" }, process.env.JWT_SECRET!, {
      algorithm: "HS256",
      issuer: "eventguard",
      audience: "eventguard-api",
      expiresIn: 300,
    });
    const res = await request(app).get(ADMIN_ONLY).set(bearer(noSub));
    expect(res.status).toBe(401);
  });

  it("accepts a valid token and reports its identity", async () => {
    const res = await request(app).get("/api/auth/me").set(bearer(tokenFor("user_a", "user")));
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ userId: "user_a", role: "user" });
  });
});

describe("demo login", () => {
  afterEach(() => {
    config.auth_demo_login_enabled = true;
  });

  it("issues a user token that the API accepts", async () => {
    const login = await request(app).post("/api/auth/demo-login").send({ userId: "user_a" });
    expect(login.status).toBe(200);
    expect(jwt.decode(login.body.token)).toMatchObject({ sub: "user_a", role: "user" });

    const me = await request(app).get("/api/auth/me").set(bearer(login.body.token));
    expect(me.body.user.role).toBe("user");
  });

  it("refuses an admin token without the admin key", async () => {
    const res = await request(app).post("/api/auth/demo-login").send({ userId: "ops", role: "admin" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_ADMIN_KEY");
  });

  it("refuses an admin token with a wrong admin key", async () => {
    const res = await request(app)
      .post("/api/auth/demo-login")
      .send({ userId: "ops", role: "admin", adminKey: "wrong-key-0123456789" });
    expect(res.status).toBe(401);
  });

  it("issues an admin token with the correct admin key", async () => {
    const res = await request(app)
      .post("/api/auth/demo-login")
      .send({ userId: "ops", role: "admin", adminKey: TEST_ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(jwt.decode(res.body.token)).toMatchObject({ sub: "ops", role: "admin" });
  });

  it("rejects unexpected fields such as a client-chosen expiry", async () => {
    const res = await request(app).post("/api/auth/demo-login").send({ userId: "user_a", exp: 9999999999 });
    expect(res.status).toBe(400);
  });

  it("is hidden when demo login is disabled", async () => {
    config.auth_demo_login_enabled = false;
    const res = await request(app).post("/api/auth/demo-login").send({ userId: "user_a" });
    expect(res.status).toBe(404);
  });
});
