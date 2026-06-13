import { afterEach, describe, expect, it, vi } from "vitest";

const originalAppUrl = process.env.APP_URL;
const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
const originalNodeEnv = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;

async function loadCookiesModule() {
  vi.resetModules();
  return import("./cookies");
}

afterEach(() => {
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }

  if (originalAuthCookieSecure === undefined) {
    delete process.env.AUTH_COOKIE_SECURE;
  } else {
    process.env.AUTH_COOKIE_SECURE = originalAuthCookieSecure;
  }

  if (originalNodeEnv === undefined) {
    delete mutableEnv.NODE_ENV;
  } else {
    mutableEnv.NODE_ENV = originalNodeEnv;
  }

  vi.resetModules();
});

describe("refresh cookie security", () => {
  it("does not mark cookies secure for local HTTP reviewer runs", async () => {
    process.env.APP_URL = "http://localhost:3000";
    delete process.env.AUTH_COOKIE_SECURE;

    const { shouldUseSecureRefreshCookie } = await loadCookiesModule();

    expect(shouldUseSecureRefreshCookie()).toBe(false);
  });

  it("marks cookies secure for HTTPS app URLs", async () => {
    process.env.APP_URL = "https://seats.example.com";
    delete process.env.AUTH_COOKIE_SECURE;

    const { shouldUseSecureRefreshCookie } = await loadCookiesModule();

    expect(shouldUseSecureRefreshCookie()).toBe(true);
  });

  it("allows an explicit secure-cookie override", async () => {
    process.env.APP_URL = "https://seats.example.com";
    process.env.AUTH_COOKIE_SECURE = "false";

    const { shouldUseSecureRefreshCookie } = await loadCookiesModule();

    expect(shouldUseSecureRefreshCookie()).toBe(false);
  });

  it("allows secure cookies to be forced on explicitly", async () => {
    process.env.APP_URL = "http://localhost:3000";
    process.env.AUTH_COOKIE_SECURE = "true";

    const { shouldUseSecureRefreshCookie } = await loadCookiesModule();

    expect(shouldUseSecureRefreshCookie()).toBe(true);
  });

  it("falls back to secure cookies in production when APP_URL is not explicitly configured", async () => {
    mutableEnv.NODE_ENV = "production";
    delete process.env.APP_URL;
    delete process.env.AUTH_COOKIE_SECURE;

    const { shouldUseSecureRefreshCookie } = await loadCookiesModule();

    expect(shouldUseSecureRefreshCookie()).toBe(true);
  });
});
