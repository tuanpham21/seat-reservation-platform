import { PaymentHttpError, toPaymentErrorResponse } from "@/server/payments/errors";
import { constructStripeWebhookEvent } from "@/server/payments/stripe";
import { processStripeWebhookEvent } from "@/server/payments/webhook";

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
    const result = await processStripeWebhookEvent(event);

    return Response.json({
      received: true,
      status: result.status,
      eventId: result.eventId
    });
  } catch (error) {
    return toPaymentErrorResponse(error);
  }
}
