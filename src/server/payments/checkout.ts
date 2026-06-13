import { PaymentStatus, Prisma, SeatHoldStatus } from "@prisma/client";
import type Stripe from "stripe";
import { z } from "zod";

import { PaymentHttpError } from "./errors";
import { buildCheckoutMetadata } from "./metadata";
import { SEAT_RESERVATION_PRICE } from "./price";
import { env } from "../env";
import { prisma } from "../prisma";
import {
  assertStripeCheckoutReady,
  getStripeClient,
  stripeProviderStatusFromError,
  toStripeCheckoutHttpError
} from "./stripe";

export const CreateCheckoutRequestSchema = z.object({
  holdId: z.string().min(1)
});

export type CreateCheckoutSessionInput = {
  userId: string;
  holdId: string;
  now?: Date;
};

export function buildReturnUrl(path: string, paymentId: string) {
  const url = new URL(path, env.APP_URL);
  url.searchParams.set("paymentId", paymentId);
  return url.toString();
}

export async function createCheckoutSession(input: CreateCheckoutSessionInput) {
  const now = input.now ?? new Date();
  const seatHold = await prisma.seatHold.findFirst({
    where: {
      id: input.holdId,
      userId: input.userId,
      status: SeatHoldStatus.active
    },
    select: {
      id: true,
      expiresAt: true
    }
  });

  if (!seatHold) {
    throw new PaymentHttpError(409, "hold_not_payable", "Hold is not available for payment.");
  }

  if (now.getTime() >= seatHold.expiresAt.getTime()) {
    throw new PaymentHttpError(409, "hold_expired", "Hold expired before payment started.");
  }

  assertStripeCheckoutReady();

  const activePayment = await findActivePayment(input.userId, seatHold.id);

  if (activePayment) {
    if (!activePayment.checkoutUrl) {
      throw new PaymentHttpError(
        409,
        "checkout_initializing",
        "A Checkout Session is already being prepared for this hold."
      );
    }

    return {
      paymentId: activePayment.id,
      checkoutSessionId: activePayment.stripeCheckoutSessionId,
      checkoutUrl: activePayment.checkoutUrl
    };
  }

  const stripe = getStripeClient();
  const payment = await createPaymentRecord(input.userId, seatHold.id);

  if (payment.checkoutUrl && payment.stripeCheckoutSessionId) {
    return {
      paymentId: payment.id,
      checkoutSessionId: payment.stripeCheckoutSessionId,
      checkoutUrl: payment.checkoutUrl
    };
  }

  const metadata = buildCheckoutMetadata({
    paymentId: payment.id,
    holdId: seatHold.id,
    userId: input.userId
  });

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        client_reference_id: payment.id,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: SEAT_RESERVATION_PRICE.currency,
              unit_amount: SEAT_RESERVATION_PRICE.unitAmountCents,
              product_data: {
                name: SEAT_RESERVATION_PRICE.productName
              }
            }
          }
        ],
        metadata,
        payment_intent_data: {
          metadata
        },
        success_url: buildReturnUrl("/payments/success", payment.id),
        cancel_url: buildReturnUrl("/payments/cancel", payment.id)
      },
      {
        idempotencyKey: `seat-hold:${seatHold.id}`
      }
    );
  } catch (error) {
    await markPaymentFailed(payment.id, error);
    throw toStripeCheckoutHttpError(error);
  }

  if (!session.url) {
    throw new PaymentHttpError(
      502,
      "stripe_checkout_url_missing",
      "Stripe did not return a Checkout URL."
    );
  }

  await prisma.payment.update({
    where: {
      id: payment.id
    },
    data: {
      stripeCheckoutSessionId: session.id,
      checkoutUrl: session.url,
      providerStatus: session.status
    }
  });

  return {
    paymentId: payment.id,
    checkoutSessionId: session.id,
    checkoutUrl: session.url
  };
}

async function findActivePayment(userId: string, seatHoldId: string) {
  return prisma.payment.findFirst({
    where: {
      userId,
      seatHoldId,
      status: {
        in: [PaymentStatus.checkout_created, PaymentStatus.processing]
      }
    },
    select: {
      id: true,
      stripeCheckoutSessionId: true,
      checkoutUrl: true
    }
  });
}

async function createPaymentRecord(userId: string, seatHoldId: string): Promise<{
  id: string;
  checkoutUrl: string | null;
  stripeCheckoutSessionId: string | null;
}> {
  try {
    return await prisma.payment.create({
      data: {
        userId,
        seatHoldId,
        amountCents: SEAT_RESERVATION_PRICE.unitAmountCents,
        currency: SEAT_RESERVATION_PRICE.currency,
        status: PaymentStatus.checkout_created,
        metadata: {
          pricing: "fixed_usd_50"
        }
      },
      select: {
        id: true,
        checkoutUrl: true,
        stripeCheckoutSessionId: true
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const activePayment = await findActivePaymentForHold(seatHoldId);

      if (activePayment?.checkoutUrl) {
        return activePayment;
      }

      throw new PaymentHttpError(
        409,
        "checkout_initializing",
        "A Checkout Session is already being prepared for this hold."
      );
    }

    throw error;
  }
}

async function findActivePaymentForHold(seatHoldId: string) {
  return prisma.payment.findFirst({
    where: {
      seatHoldId,
      status: {
        in: [PaymentStatus.checkout_created, PaymentStatus.processing]
      }
    },
    select: {
      id: true,
      checkoutUrl: true,
      stripeCheckoutSessionId: true
    }
  });
}

async function markPaymentFailed(paymentId: string, error: unknown) {
  await prisma.payment.update({
    where: {
      id: paymentId
    },
    data: {
      status: PaymentStatus.failed,
      providerStatus: stripeProviderStatusFromError(error)
    }
  });
}
