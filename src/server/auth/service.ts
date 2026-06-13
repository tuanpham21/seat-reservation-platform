import { Prisma } from "@prisma/client";
import { env } from "@/server/env";
import { prisma } from "@/server/prisma";
import { addDays, isPast } from "@/server/time";
import { AuthError } from "./errors";
import { hashPassword, verifyPassword } from "./passwords";
import { loginTimingDummyHash } from "./timing";
import {
  createOpaqueToken,
  createSessionFamilyId,
  hashToken,
  secureCompareHash,
  signAccessToken
} from "./tokens";

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: {
    id: string;
    email: string;
  };
};

type SessionUser = {
  id: string;
  email: string;
};

class RefreshTokenReuseDetected extends Error {
  constructor(
    readonly sessionFamilyId: string,
    readonly detectedAt: Date
  ) {
    super("Refresh token reuse detected.");
    this.name = "RefreshTokenReuseDetected";
  }
}

async function issueSession(user: SessionUser, sessionFamilyId = createSessionFamilyId()) {
  const now = new Date();
  const refreshToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();

  await prisma.userSession.create({
    data: {
      userId: user.id,
      sessionFamilyId,
      refreshTokenHash: hashToken(refreshToken),
      csrfTokenHash: hashToken(csrfToken),
      expiresAt: addDays(now, env.REFRESH_SESSION_TTL_DAYS)
    }
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    sessionFamilyId
  });

  return {
    accessToken,
    refreshToken,
    csrfToken,
    user
  };
}

export async function registerUser(email: string, password: string): Promise<AuthResult> {
  try {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password)
      },
      select: { id: true, email: true }
    });

    return issueSession(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AuthError("An authenticated user already exists for that email.", "email_taken");
    }
    throw error;
  }
}

export async function loginUser(email: string, password: string): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true }
  });

  const passwordHash = user?.passwordHash ?? loginTimingDummyHash;
  const passwordMatches = await verifyPassword(passwordHash, password);

  if (!user || !passwordMatches) {
    throw new AuthError("Email or password is incorrect.", "invalid_credentials");
  }

  return issueSession({ id: user.id, email: user.email });
}

export async function refreshUserSession(refreshToken: string, csrfToken: string): Promise<AuthResult> {
  const refreshTokenHash = hashToken(refreshToken);
  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.userSession.findUnique({
        where: { refreshTokenHash },
        include: { user: { select: { id: true, email: true } } }
      });

      if (!existing) {
        throw new AuthError("User session is missing.", "missing_session");
      }

      if (!secureCompareHash(csrfToken, existing.csrfTokenHash)) {
        throw new AuthError("CSRF check failed.", "csrf_failed");
      }

      if (existing.revokedAt || existing.rotatedAt) {
        throw new RefreshTokenReuseDetected(existing.sessionFamilyId, now);
      }

      if (isPast(existing.expiresAt, now)) {
        await tx.userSession.update({
          where: { id: existing.id },
          data: { revokedAt: now }
        });
        throw new AuthError("User session expired.", "invalid_session");
      }

      const rotated = await tx.userSession.updateMany({
        where: {
          id: existing.id,
          refreshTokenHash,
          revokedAt: null,
          rotatedAt: null,
          expiresAt: { gt: now }
        },
        data: {
          rotatedAt: now,
          revokedAt: now
        }
      });

      if (rotated.count !== 1) {
        throw new RefreshTokenReuseDetected(existing.sessionFamilyId, now);
      }

      const nextRefreshToken = createOpaqueToken();
      const nextCsrfToken = createOpaqueToken();

      await tx.userSession.create({
        data: {
          userId: existing.userId,
          sessionFamilyId: existing.sessionFamilyId,
          refreshTokenHash: hashToken(nextRefreshToken),
          csrfTokenHash: hashToken(nextCsrfToken),
          expiresAt: addDays(now, env.REFRESH_SESSION_TTL_DAYS)
        }
      });

      const accessToken = await signAccessToken({
        sub: existing.user.id,
        email: existing.user.email,
        sessionFamilyId: existing.sessionFamilyId
      });

      return {
        accessToken,
        refreshToken: nextRefreshToken,
        csrfToken: nextCsrfToken,
        user: existing.user
      };
    });
  } catch (error) {
    if (error instanceof RefreshTokenReuseDetected) {
      await prisma.userSession.updateMany({
        where: { sessionFamilyId: error.sessionFamilyId, revokedAt: null },
        data: { revokedAt: error.detectedAt }
      });
      throw new AuthError("Refresh token reuse detected.", "invalid_session");
    }

    throw error;
  }
}

export async function logoutUserSession(refreshToken: string, csrfToken: string) {
  const refreshTokenHash = hashToken(refreshToken);
  const existing = await prisma.userSession.findUnique({
    where: { refreshTokenHash }
  });

  if (!existing) {
    return;
  }

  if (!secureCompareHash(csrfToken, existing.csrfTokenHash)) {
    throw new AuthError("CSRF check failed.", "csrf_failed");
  }

  await prisma.userSession.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() }
  });
}
