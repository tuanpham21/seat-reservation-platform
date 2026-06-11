import type { NextRequest } from "next/server";
import {
  authErrorResponse,
  clearedAuthResponse,
  clearAuthOnResponse,
  requireRefreshAndCsrf
} from "@/server/auth/http";
import { logoutUserSession } from "@/server/auth/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { refreshToken, csrfToken } = requireRefreshAndCsrf(request);
    await logoutUserSession(refreshToken, csrfToken);
    return clearedAuthResponse();
  } catch (error) {
    return clearAuthOnResponse(authErrorResponse(error));
  }
}
