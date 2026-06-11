import { requireAuthenticatedUser } from "@/server/auth/bearer";
import { PaymentHttpError } from "./errors";

export type PaymentUser = {
  id: string;
  email?: string;
};

export async function requirePaymentUser(request: Request): Promise<PaymentUser> {
  try {
    const user = await requireAuthenticatedUser(request);
    return {
      id: user.id,
      email: user.email
    };
  } catch {
    throw new PaymentHttpError(401, "authentication_required", "Sign in before paying.");
  }
}
