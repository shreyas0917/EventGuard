import { describe, it, expect, beforeEach, afterEach } from "vitest";

const { config, KNOWN_JWT_SECRETS } = await import("../../src/config/index.js");
const { validateEnvironment } = await import("../../src/config/validateEnv.js");

const original = { ...config };
const errors = () => validateEnvironment().errors.join("\n");

describe("startup validation of auth settings", () => {
  beforeEach(() => {
    Object.assign(config, { node_env: "production", auth_demo_login_enabled: false, jwt_secret: "x".repeat(48) });
  });
  afterEach(() => {
    Object.assign(config, original);
  });

  it("accepts a strong secret with demo login off", () => {
    expect(validateEnvironment().valid).toBe(true);
  });

  it("requires JWT_SECRET", () => {
    config.jwt_secret = "";
    expect(errors()).toMatch(/JWT_SECRET is required/);
  });

  it("rejects a short JWT_SECRET", () => {
    config.jwt_secret = "too-short";
    expect(errors()).toMatch(/at least 32 characters/);
  });

  it.each(KNOWN_JWT_SECRETS)("rejects the published placeholder %s in production", (secret) => {
    config.jwt_secret = secret;
    expect(errors()).toMatch(/publicly known placeholder/);
  });

  it("refuses demo login in production", () => {
    config.auth_demo_login_enabled = true;
    expect(errors()).toMatch(/AUTH_DEMO_LOGIN must be false/);
  });

  it("rejects a weak admin key", () => {
    config.admin_api_key = "short";
    expect(errors()).toMatch(/ADMIN_API_KEY must be at least 16/);
  });
});
