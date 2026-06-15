import { PaymentHttpError, toPaymentErrorResponse } from "@/server/payments/errors";
import { notifyStripeWebhookEnqueued } from "@/server/runtime";
import { constructStripeWebhookEvent } from "@/server/payments/stripe";
import { enqueueStripeWebhookEvent } from "@/server/payments/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      throw new PaymentHttpError(
        400,
        "stripe_signature_missing",
        "Stripe webhook signature is required."
      );
    }

    const rawBody = await request.text();
    const event = constructStripeWebhookEvent(rawBody, signature);
    const queued = await enqueueStripeWebhookEvent(event);
    if (queued.status === "accepted") {
      notifyStripeWebhookEnqueued();
    }

    return Response.json({
      received: true,
      status: queued.status,
      eventId: queued.eventId
    });
  } catch (error) {
    return toPaymentErrorResponse(error);
  }
}
