import type { NextRequest } from "next/server";
import { prisma } from "@/server/prisma";
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
    const activeSession = await prisma.userSession.findFirst({
      where: {
        userId: claims.sub,
        sessionFamilyId: claims.sessionFamilyId,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      select: { id: true }
    });

    if (!activeSession) {
      throw new AuthError("Bearer access token has been revoked.", "invalid_session");
    }

    return {
      id: claims.sub,
      email: claims.email,
      sessionFamilyId: claims.sessionFamilyId
    };
  } catch {
    throw new AuthError("Bearer access token is invalid.", "invalid_session");
  }
}
