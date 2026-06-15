import type { NextRequest } from "next/server";
import { authErrorResponse, authSuccess, rateLimitAuth, rateLimitAuthIdentity } from "@/server/auth/http";
import { loginUser } from "@/server/auth/service";
import { authFormSchema } from "@/server/auth/validation";
import { apiError } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    rateLimitAuth(request, "login");
    const parsed = authFormSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError("bad_request", "Valid email and password are required.", 400);
    }
    rateLimitAuthIdentity(parsed.data.email, "login");
    return authSuccess(await loginUser(parsed.data.email, parsed.data.password));
  } catch (error) {
    return authErrorResponse(error);
  }
}
