import type { NextRequest } from "next/server";
import { AuthError } from "./errors";
import { verifyAccessToken } from "./tokens";

export async function requireAuthenticatedUser(request: NextRequest | Request) {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new AuthError("Bearer access token is required.", "missing_session");
  }

  try {
    const claims = await verifyAccessToken(match[1]);
    return {
      id: claims.sub,
      email: claims.email,
      sessionFamilyId: claims.sessionFamilyId
    };
  } catch {
    throw new AuthError("Bearer access token is invalid.", "invalid_session");
  }
}
