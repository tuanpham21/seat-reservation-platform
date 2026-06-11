import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "@/server/env";

const accessSecret = new TextEncoder().encode(env.JWT_SECRET);

export type AccessTokenClaims = {
  sub: string;
  email: string;
  sessionFamilyId: string;
};

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function createSessionFamilyId() {
  return randomUUID();
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export function secureCompareHash(plainToken: string, expectedHash: string) {
  const actualHash = hashToken(plainToken);
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function signAccessToken(claims: AccessTokenClaims) {
  return new SignJWT({
    email: claims.email,
    sessionFamilyId: claims.sessionFamilyId
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, accessSecret);

  if (
    !payload.sub ||
    typeof payload.email !== "string" ||
    typeof payload.sessionFamilyId !== "string"
  ) {
    throw new Error("Invalid access token claims");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    sessionFamilyId: payload.sessionFamilyId
  };
}
