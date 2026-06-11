import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { apiError, ok } from "@/server/http";
import { AuthError } from "./errors";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "./cookies";
import { assertRateLimit } from "./rate-limit";
import type { AuthResult } from "./service";

export function authErrorResponse(error: unknown) {
  if (!(error instanceof AuthError)) {
    console.error(error);
    return apiError("server_error", "Unexpected authentication error.", 500);
  }

  if (error.code === "rate_limited") return apiError("rate_limited", error.message, 429);
  if (error.code === "csrf_failed") return apiError("forbidden", error.message, 403);
  if (error.code === "email_taken") return apiError("conflict", error.message, 409);
  return apiError("unauthorized", error.message, 401);
}

export function clientIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function rateLimitAuth(request: NextRequest, action: "login" | "register" | "refresh") {
  assertRateLimit(`${action}:${clientIp(request)}`, {
    limit: action === "refresh" ? 30 : 10,
    windowMs: 60_000
  });
}

export function authSuccess(result: AuthResult, init?: ResponseInit) {
  const response = ok(
    {
      accessToken: result.accessToken,
      csrfToken: result.csrfToken,
      user: result.user
    },
    init
  );
  setRefreshCookie(response, result.refreshToken);
  return response;
}

export function requireRefreshAndCsrf(request: NextRequest) {
  const refreshToken = readRefreshCookie(request);
  const csrfToken = request.headers.get("x-csrf-token");

  if (!refreshToken) {
    throw new AuthError("Refresh user session is missing.", "missing_session");
  }
  if (!csrfToken) {
    throw new AuthError("CSRF token is required.", "csrf_failed");
  }

  return { refreshToken, csrfToken };
}

export function clearAuthOnResponse(response: NextResponse) {
  clearRefreshCookie(response);
  return response;
}

export function clearedAuthResponse() {
  return clearAuthOnResponse(NextResponse.json({ ok: true }));
}
