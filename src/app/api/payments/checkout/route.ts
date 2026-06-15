import { createCheckoutSession, CreateCheckoutRequestSchema } from "@/server/payments/checkout";
import { toPaymentErrorResponse, PaymentHttpError } from "@/server/payments/errors";
import { requirePaymentUser } from "@/server/payments/auth";
import { checkRateLimit } from "@/server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requirePaymentUser(request);
    const rateLimit = checkRateLimit(`payment-checkout:${user.id}`, {
      limit: 10,
      windowMs: 60_000
    });
    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many checkout attempts. Try again shortly."
          }
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000)))
          }
        }
      );
    }
    const body = CreateCheckoutRequestSchema.safeParse(await request.json());

    if (!body.success) {
      throw new PaymentHttpError(400, "invalid_checkout_request", "Invalid checkout request.", {
        issues: body.error.issues
      });
    }

    const result = await createCheckoutSession({
      userId: user.id,
      holdId: body.data.holdId
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    return toPaymentErrorResponse(error);
  }
}
