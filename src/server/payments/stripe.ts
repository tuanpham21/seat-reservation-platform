import Stripe from "stripe";

import { PaymentHttpError } from "./errors";

let cachedStripe: Stripe | null = null;

type StripeErrorLike = {
  type?: string;
  statusCode?: number;
};

const STRIPE_SECRET_PLACEHOLDERS = new Set(["sk_test_replace_me"]);

export function getStripeSecretKey() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new PaymentHttpError(
      503,
      "stripe_secret_missing",
      "STRIPE_SECRET_KEY is required for payment processing."
    );
  }

  if (STRIPE_SECRET_PLACEHOLDERS.has(secretKey)) {
    throw new PaymentHttpError(
      503,
      "stripe_secret_placeholder",
      "Configure a real Stripe test secret key before starting payment."
    );
  }

  if (!secretKey.startsWith("sk_test_")) {
    throw new PaymentHttpError(
      503,
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

export function resetStripeClientForTests() {
  cachedStripe = null;
}

function asStripeError(error: unknown): StripeErrorLike | null {
  if (!error || typeof error !== "object") return null;

  const candidate = error as StripeErrorLike;
  if (typeof candidate.type === "string" || typeof candidate.statusCode === "number") {
    return candidate;
  }

  return null;
}

export function stripeProviderStatusFromError(error: unknown) {
  const stripeError = asStripeError(error);
  return stripeError?.type ?? "stripe_error";
}

export function toStripeCheckoutHttpError(error: unknown) {
  const stripeError = asStripeError(error);

  if (stripeError?.type === "StripeAuthenticationError" || stripeError?.statusCode === 401) {
    return new PaymentHttpError(
      503,
      "stripe_authentication_failed",
      "Stripe rejected the configured test secret key."
    );
  }

  if (stripeError) {
    return new PaymentHttpError(
      502,
      "stripe_checkout_failed",
      "Stripe Checkout could not be started. Please retry."
    );
  }

  return new PaymentHttpError(
    502,
    "stripe_checkout_failed",
    "Stripe Checkout could not be started. Please retry."
  );
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
