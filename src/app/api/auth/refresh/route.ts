import type { NextRequest } from "next/server";
import {
  authErrorResponse,
  authSuccess,
  clearAuthOnResponse,
  rateLimitAuth,
  rateLimitAuthIdentity,
  requireRefreshAndCsrf
} from "@/server/auth/http";
import { refreshUserSession } from "@/server/auth/service";
import { hashToken } from "@/server/auth/tokens";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    rateLimitAuth(request, "refresh");
    const { refreshToken, csrfToken } = requireRefreshAndCsrf(request);
    rateLimitAuthIdentity(hashToken(refreshToken), "refresh");
    return authSuccess(await refreshUserSession(refreshToken, csrfToken));
  } catch (error) {
    return clearAuthOnResponse(authErrorResponse(error));
  }
}
