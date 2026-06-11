import Stripe from "stripe";

import { PaymentHttpError } from "./errors";

let cachedStripe: Stripe | null = null;

function getStripeSecretKey() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new PaymentHttpError(
      500,
      "stripe_secret_missing",
      "STRIPE_SECRET_KEY is required for payment processing."
    );
  }

  if (!secretKey.startsWith("sk_test_")) {
    throw new PaymentHttpError(
      500,
      "stripe_test_key_required",
      "Stripe Checkout must use a test mode secret key."
    );
  }

  return secretKey;
}

export function getStripeClient() {
  if (!cachedStripe) {
    cachedStripe = new Stripe(getStripeSecretKey());
  }

  return cachedStripe;
}

export function constructStripeWebhookEvent(rawBody: string, signature: string) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new PaymentHttpError(
      500,
      "stripe_webhook_secret_missing",
      "STRIPE_WEBHOOK_SECRET is required for webhook verification."
    );
  }

  try {
    return getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    throw new PaymentHttpError(
      400,
      "stripe_signature_invalid",
      "Stripe webhook signature verification failed."
    );
  }
}
