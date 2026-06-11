import type { NextRequest, NextResponse } from "next/server";
import { env } from "@/server/env";

export const refreshCookieName = "seat_refresh";

export function readRefreshCookie(request: NextRequest) {
  return request.cookies.get(refreshCookieName)?.value ?? null;
}

export function setRefreshCookie(response: NextResponse, refreshToken: string) {
  response.cookies.set(refreshCookieName, refreshToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: env.REFRESH_SESSION_TTL_DAYS * 24 * 60 * 60
  });
}

export function clearRefreshCookie(response: NextResponse) {
  response.cookies.set(refreshCookieName, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: 0
  });
}
