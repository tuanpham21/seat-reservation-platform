import { jwtVerify } from "jose";

import { PaymentHttpError } from "./errors";

export type PaymentUser = {
  id: string;
  email?: string;
};

function signingKey() {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new PaymentHttpError(
      500,
      "auth_secret_missing",
      "JWT_SECRET must be configured before payment requests are accepted."
    );
  }

  return new TextEncoder().encode(secret);
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export async function requirePaymentUser(request: Request): Promise<PaymentUser> {
  const token = getBearerToken(request);

  if (!token) {
    throw new PaymentHttpError(401, "authentication_required", "Sign in before paying.");
  }

  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: ["HS256"]
  });

  const userId = typeof payload.sub === "string" ? payload.sub : null;

  if (!userId) {
    throw new PaymentHttpError(401, "invalid_session", "Session token is missing a user id.");
  }

  return {
    id: userId,
    email: typeof payload.email === "string" ? payload.email : undefined
  };
}
