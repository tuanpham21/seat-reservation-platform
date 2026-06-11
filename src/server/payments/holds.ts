import { jwtVerify } from "jose";

import { PaymentHttpError } from "./errors";

export type PayableHold = {
  id: string;
  expiresAt: Date;
};

function holdSigningKey() {
  const secret = process.env.PAYMENT_HOLD_TOKEN_SECRET ?? process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new PaymentHttpError(
      500,
      "hold_token_secret_missing",
      "PAYMENT_HOLD_TOKEN_SECRET or JWT_SECRET must be configured."
    );
  }

  return new TextEncoder().encode(secret);
}

export async function verifyPayableHoldToken(
  token: string,
  userId: string,
  now = new Date()
): Promise<PayableHold> {
  const { payload } = await jwtVerify(token, holdSigningKey(), {
    algorithms: ["HS256"]
  });

  if (payload.sub !== userId) {
    throw new PaymentHttpError(403, "hold_user_mismatch", "Hold does not belong to this user.");
  }

  const holdId = typeof payload.hold_id === "string" ? payload.hold_id : null;
  const holdExpiresAt = typeof payload.hold_expires_at === "string" ? payload.hold_expires_at : null;

  if (!holdId || !holdExpiresAt) {
    throw new PaymentHttpError(400, "invalid_hold_token", "Hold token is missing payment data.");
  }

  const expiresAt = new Date(holdExpiresAt);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new PaymentHttpError(400, "invalid_hold_expiry", "Hold token has an invalid expiry.");
  }

  if (now.getTime() >= expiresAt.getTime()) {
    throw new PaymentHttpError(409, "hold_expired", "Hold expired before payment started.");
  }

  return {
    id: holdId,
    expiresAt
  };
}
