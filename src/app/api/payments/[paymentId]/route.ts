import { requirePaymentUser } from "@/server/payments/auth";
import { toPaymentErrorResponse } from "@/server/payments/errors";
import { getPaymentStatus } from "@/server/payments/status";
import { checkRateLimit } from "@/server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: {
      paymentId: string;
    };
  }
) {
  try {
    const user = await requirePaymentUser(request);
    const rateLimit = checkRateLimit(`payment-status:${user.id}:${context.params.paymentId}`, {
      limit: 120,
      windowMs: 60_000
    });
    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many payment status checks. Try again shortly."
          }
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))),
            "Cache-Control": "no-store",
            Vary: "Authorization"
          }
        }
      );
    }
    const status = await getPaymentStatus(context.params.paymentId, user.id);

    return Response.json(status, {
      headers: {
        "Cache-Control": "no-store",
        Vary: "Authorization"
      }
    });
  } catch (error) {
    return toPaymentErrorResponse(error);
  }
}
