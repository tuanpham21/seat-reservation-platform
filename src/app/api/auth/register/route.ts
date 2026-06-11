import type { NextRequest } from "next/server";
import { authErrorResponse, authSuccess, rateLimitAuth } from "@/server/auth/http";
import { registerUser } from "@/server/auth/service";
import { authFormSchema } from "@/server/auth/validation";
import { apiError } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    rateLimitAuth(request, "register");
    const parsed = authFormSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError("bad_request", "Valid email and password are required.", 400);
    }
    return authSuccess(await registerUser(parsed.data.email, parsed.data.password), { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
