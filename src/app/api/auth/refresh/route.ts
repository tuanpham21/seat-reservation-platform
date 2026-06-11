import type { NextRequest } from "next/server";
import {
  authErrorResponse,
  authSuccess,
  clearAuthOnResponse,
  rateLimitAuth,
  requireRefreshAndCsrf
} from "@/server/auth/http";
import { refreshUserSession } from "@/server/auth/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    rateLimitAuth(request, "refresh");
    const { refreshToken, csrfToken } = requireRefreshAndCsrf(request);
    return authSuccess(await refreshUserSession(refreshToken, csrfToken));
  } catch (error) {
    return clearAuthOnResponse(authErrorResponse(error));
  }
}
